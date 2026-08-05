import { InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { plural, t } from "../foundation/i18n/index.js";
import { formatMsk } from "../interfaces/telegram/time.js";
import type { StudioServices } from "../studio/services/index.js";
import { clearConversationState, getConversationState, saveConversationState } from "./conversation-state.js";
import { cancelPromptKeyboard, resultNavigationKeyboard } from "./dialog-ui.js";
import type { PublicationEffect } from "./effects.js";
import { botLocale } from "./i18n.js";
import { type PostWizardStep, postStateStep } from "./post-fsm.js";
import { showStoryCardChoice } from "./post-story-cards.js";
import { type DraftView, isDraftView, modeLabel } from "./preview.js";
import { renderPostProgress } from "./progress.js";
import type { PublicationActionContext, PublicationActionResult } from "./publication-action-types.js";
import { renderPublicationCard } from "./publication-card.js";
import { publicationCardEffect } from "./publication-card-effects.js";
import { type PostActionKey, publicationCallback } from "./session-fsm.js";
import { callbackMessageId } from "./telegram-context.js";

type PostActionArgs = PublicationActionContext;
type PostActionHandler = (args: PostActionArgs) => Promise<PublicationActionResult>;

export const postActionHandlers: Record<Exclude<PostActionKey, "cancel_dialog">, PostActionHandler> = {
  toggle: handleToggle,
  preview: handlePreview,
  platforms: handlePlatforms,
  cycle_mode: handleCycleMode,
  cancel_state: handleCancelState,
  edit_ru: handleEdit,
  edit_en: handleEdit,
  replace_ru_media: handleEdit,
  replace_en_media: handleEdit,
  sources: handleSources,
  cancel: handleCancel,
  cancel_confirm: handleCancelConfirm,
  post_retry: handleRetry,
  post_retry_notice: handleRetry,
  publish: handlePublish,
  story_publish_all: handleStoryChoice,
  story_publish_site: handleStoryChoice,
  story_schedule_all: handleStoryChoice,
  story_schedule_site: handleStoryChoice,
  threads_chain: handleThreadsChain,
  publish_confirm: handlePublishConfirm,
  schedule: handleSchedule,
  sched_scope: handleScheduleScope,
  sched_view: handleScheduleView,
  sched_pick: handleSchedulePick,
  sched_confirm: handleManualScheduleConfirm,
  sched_manual_confirm: handleManualScheduleConfirm,
  sched_manual: handleManualSchedule,
};

const POST_INPUT_STEPS: Record<string, PostWizardStep> = {
  edit_ru: { type: "edit_text", locale: "ru" },
  edit_en: { type: "edit_text", locale: "en" },
  replace_ru_media: { type: "replace_media", locale: "ru" },
  replace_en_media: { type: "replace_media", locale: "en" },
};

async function handleToggle({
  backendDb,
  config,
  actorId,
  locale,
  second,
  draftId,
  pipeline,
}: PostActionArgs): Promise<PublicationActionResult> {
  if (!second) return [{ type: "toast", text: t(locale, "action.unknown") }];
  pipeline.toggleTarget(actorId, draftId, second);
  return previewEffects(backendDb, draftId, config, "platforms", t(locale, "action.target-updated", { target: second }));
}

async function handlePreview({ backendDb, config, draftId }: PostActionArgs): Promise<PublicationActionResult> {
  return previewEffects(backendDb, draftId, config);
}

async function handlePlatforms({ backendDb, config, draftId }: PostActionArgs): Promise<PublicationActionResult> {
  return previewEffects(backendDb, draftId, config, "platforms");
}

async function handleCycleMode({
  backendDb,
  config,
  actorId,
  locale,
  draftId,
  services,
}: PostActionArgs): Promise<PublicationActionResult> {
  const posts = services.posts;
  const nextMode = posts.cycleMode(actorId, draftId);
  return previewEffects(backendDb, draftId, config, "overview", `${t(locale, "post.mode")}: ${modeLabel(nextMode, locale)}`);
}

async function handleCancelState({ backendDb, config, actorId, second, draftId }: PostActionArgs): Promise<PublicationActionResult> {
  clearConversationState(backendDb, actorId, "post");
  return previewEffects(backendDb, draftId, config, second && isDraftView(second) ? second : "overview");
}

async function handleEdit({ ctx, backendDb, actorId, locale, action, draftId }: PostActionArgs): Promise<PublicationActionResult> {
  const step = POST_INPUT_STEPS[action];
  if (!step) throw new StudioError("action.session-stale");
  savePostState(backendDb, actorId, step, draftId, callbackMessageId(ctx));
  return [
    { type: "toast", text: t(locale, "action.send-replacement") },
    promptEffect(
      backendDb,
      actorId,
      draftId,
      action.startsWith("edit") ? t(locale, "action.send-new-text") : t(locale, "action.send-new-media"),
    ),
  ];
}

async function handleSources({ ctx, backendDb, actorId, locale, draftId }: PostActionArgs): Promise<PublicationActionResult> {
  savePostState(backendDb, actorId, { type: "edit_sources" }, draftId, callbackMessageId(ctx));
  return [{ type: "answer-callback" }, promptEffect(backendDb, actorId, draftId, t(locale, "post.sources-prompt"))];
}

async function handleCancel({ backendDb, config, draftId }: PostActionArgs): Promise<PublicationActionResult> {
  return previewEffects(backendDb, draftId, config, "confirm_delete");
}

async function handleCancelConfirm({ actorId, locale, draftId, pipeline }: PostActionArgs): Promise<PublicationActionResult> {
  pipeline.cancel(actorId, draftId);
  return [
    { type: "toast", text: t(locale, "action.cancelled") },
    {
      type: "screen",
      mode: "edit",
      text: t(locale, "action.draft-cancelled", { id: draftId }),
      options: { reply_markup: resultNavigationKeyboard(locale, "drafts") },
    },
  ];
}

async function handleRetry({
  backendDb,
  config,
  actorId,
  locale,
  action,
  second,
  draftId,
  pipeline,
}: PostActionArgs): Promise<PublicationActionResult> {
  const result = pipeline.retryTarget(actorId, draftId, second || "") as { requeued: number; alreadyQueued: number };
  if (action !== "post_retry")
    return [
      {
        type: "toast",
        text: t(locale, "action.retry-result", { requeued: result.requeued, alreadyQueued: result.alreadyQueued }),
      },
    ];
  const preview = renderPublicationCard("post", { backendDb, config, publicationId: draftId });
  return [
    {
      type: "toast",
      text: t(locale, "action.retry-result", { requeued: result.requeued, alreadyQueued: result.alreadyQueued }),
    },
    ...publicationCardEffect("post", draftId, preview),
  ];
}

async function handlePublish(args: PostActionArgs): Promise<PublicationActionResult> {
  return showPublicationIntent(args, "publish");
}

async function handleStoryChoice({
  backendDb,
  config,
  actorId,
  locale,
  action,
  draftId,
  services,
}: PostActionArgs): Promise<PublicationActionResult> {
  const posts = services.posts;
  posts.setStoryPublishMode(actorId, draftId, action.endsWith("_all") ? "all" : "site_only");
  return action.startsWith("story_publish_")
    ? queuePostNow(services, actorId, draftId, locale)
    : previewEffects(backendDb, draftId, config, "schedule");
}

async function handleThreadsChain({
  ctx,
  backendDb,
  config,
  actorId,
  locale,
  draftId,
  services,
}: PostActionArgs): Promise<PublicationActionResult> {
  const posts = services.posts;
  posts.approveThreadsChain(actorId, draftId);
  // The waiver only clears the Threads rule. Other preflight issues remain fatal.
  const preflight = await showPublicationPreflight(services, backendDb, actorId, draftId, locale);
  if (preflight) return preflight;
  const storyChoice = await showStoryCardChoice(ctx, backendDb, config, actorId, draftId, "publish");
  if (storyChoice) return storyChoice;
  return [
    { type: "toast", text: t(locale, "action.preflight-chain-approved") },
    ...sendPublishConfirmation(services, backendDb, config, actorId, draftId),
  ];
}

async function handlePublishConfirm({ actorId, locale, draftId, services }: PostActionArgs): Promise<PublicationActionResult> {
  return queuePostNow(services, actorId, draftId, locale);
}

async function handleSchedule(args: PostActionArgs): Promise<PublicationActionResult> {
  const { backendDb, actorId } = args;
  clearConversationState(backendDb, actorId, "post");
  return showPublicationIntent(args, "schedule");
}

async function showPublicationIntent(args: PostActionArgs, intent: "publish" | "schedule"): Promise<PublicationActionResult> {
  const { backendDb, config, actorId, locale, draftId, services } = args;
  const preflight = await showPublicationPreflight(services, backendDb, actorId, draftId, locale);
  if (preflight) return preflight;
  const storyChoice = await showStoryCardChoice(args.ctx, backendDb, config, actorId, draftId, intent);
  if (storyChoice) return storyChoice;
  return intent === "publish"
    ? sendPublishConfirmation(services, backendDb, config, actorId, draftId)
    : previewEffects(backendDb, draftId, config, "schedule");
}

async function handleScheduleScope({
  backendDb,
  config,
  actorId,
  locale,
  first,
  draftId,
  services,
}: PostActionArgs): Promise<PublicationActionResult> {
  if (!first) return [{ type: "toast", text: t(locale, "action.unknown") }];
  clearConversationState(backendDb, actorId, "post");
  if (first === "ru_now") return commitLocaleSchedule(services, backendDb, config, actorId, draftId, "ru", new Date(), "ru");
  if (first === "en_now") return commitLocaleSchedule(services, backendDb, config, actorId, draftId, "en", new Date(), "en");
  if (first === "both") return previewEffects(backendDb, draftId, config, "schedule_ru");
  return [{ type: "toast", text: t(locale, "action.unknown") }];
}

async function handleScheduleView({ backendDb, config, actorId, first, draftId }: PostActionArgs): Promise<PublicationActionResult> {
  if (!first || !isDraftView(first)) return;
  clearConversationState(backendDb, actorId, "post");
  return previewEffects(backendDb, draftId, config, first);
}

async function handleSchedulePick({
  backendDb,
  config,
  actorId,
  first,
  second,
  draftId,
  pipeline,
  services,
}: PostActionArgs): Promise<PublicationActionResult> {
  if (!first || !second) return;
  if (pipeline.capabilities.scheduleAxis !== "locale") throw new StudioError("action.schedule-expired");
  clearConversationState(backendDb, actorId, "post");
  const value = pipeline.slotTime(`${second.slice(0, 2)}:${second.slice(2, 4)}`);
  return commitLocaleSchedule(services, backendDb, config, actorId, draftId, requireScheduleLocale(first), value);
}

async function handleManualScheduleConfirm({
  backendDb,
  config,
  actorId,
  locale,
  draftId,
  services,
}: PostActionArgs): Promise<PublicationActionResult> {
  const state = getConversationState(backendDb, actorId, "post");
  const stateStep = postStateStep(state);
  if (stateStep?.type !== "schedule_confirm" || state?.draftId !== draftId)
    return [{ type: "toast", text: t(locale, "action.schedule-expired") }];
  const { locale: scope, value } = stateStep;
  clearConversationState(backendDb, actorId, "post");
  return commitLocaleSchedule(services, backendDb, config, actorId, draftId, scope, value);
}

async function handleManualSchedule({
  ctx,
  backendDb,
  actorId,
  locale,
  first,
  draftId,
  config,
}: PostActionArgs): Promise<PublicationActionResult> {
  if (!first) return;
  const pickLocale = requireScheduleLocale(first);
  clearConversationState(backendDb, actorId, "post");
  savePostState(backendDb, actorId, { type: "schedule_manual", locale: pickLocale }, draftId, callbackMessageId(ctx));
  return [
    { type: "toast", text: t(locale, "action.send-time") },
    promptEffect(
      backendDb,
      actorId,
      draftId,
      t(locale, "action.enter-datetime", { timezone: config.TIMEZONE_LABEL }),
      pickLocale === "ru" ? "schedule_ru" : "schedule_en",
    ),
  ];
}

async function queuePostNow(
  services: StudioServices,
  actorId: number,
  draftId: number,
  locale: ReturnType<typeof botLocale>,
): Promise<PublicationActionResult> {
  const posts = services.posts;
  posts.publish(actorId, draftId);
  const progress = renderPostProgress(posts.progress(actorId, draftId), locale);
  return [
    { type: "toast", text: t(locale, "action.queued") },
    { type: "screen", mode: "edit", text: t(locale, "action.post-queued", { id: draftId }) },
    {
      type: "prompt",
      text: progress.text,
      options: { parse_mode: "Markdown", reply_markup: progress.keyboard },
      card: { kind: "post-progress", draftId },
    },
  ];
}

/** Commits one locale's schedule immediately (button/auto pick, or "now"). If
 * the other locale still needs a time and has enabled targets, hands off to
 * its slot screen instead of finishing; otherwise shows the final result. */
async function commitLocaleSchedule(
  services: StudioServices,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  scheduleLocale: "ru" | "en",
  value: Date,
  immediateLocale?: "ru" | "en",
): Promise<PublicationEffect[]> {
  const posts = services.posts;
  const { ruAt, enAt } = posts.scheduleAt(actorId, draftId, scheduleLocale, value);
  const postId = posts.schedule(actorId, draftId, {
    ruAt,
    enAt,
    ...(immediateLocale ? { immediateLocale } : {}),
  });
  const otherLocale = scheduleLocale === "ru" ? "en" : "ru";
  const otherAt = otherLocale === "ru" ? ruAt : enAt;
  const uiLocale = botLocale(backendDb, actorId);
  if (!otherAt && posts.hasLocaleTargets(actorId, draftId, otherLocale)) {
    return previewEffects(backendDb, draftId, config, otherLocale === "ru" ? "schedule_ru" : "schedule_en");
  }
  return [
    { type: "toast", text: t(uiLocale, "common.scheduled") },
    {
      type: "screen",
      mode: "edit",
      text: scheduledDraftText(uiLocale, draftId, postId, ruAt, enAt, config),
      options: { reply_markup: resultNavigationKeyboard(uiLocale, "upcoming") },
    },
  ];
}

function sendPublishConfirmation(
  services: StudioServices,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
): PublicationEffect[] {
  const delivery = services.posts.preview(actorId, draftId).delivery;
  const preview = renderPublicationCard("post", { backendDb, config, publicationId: draftId, view: "confirm_publish" });
  return [
    { type: "delivery-previews", projections: delivery.projections, locale: botLocale(backendDb, actorId) },
    {
      type: "prompt",
      text: preview.text,
      options: { parse_mode: "Markdown", reply_markup: preview.keyboard },
      card: { kind: "post", draftId },
    },
  ];
}

async function showPublicationPreflight(
  services: StudioServices,
  backendDb: BackendDb,
  actorId: number,
  draftId: number,
  locale: ReturnType<typeof botLocale>,
): Promise<PublicationEffect[] | null> {
  const issues = services.posts.validate(actorId, draftId);
  const issue = issues[0];
  if (!issue) return null;
  // A waivable issue needs a message, not an alert: an alert cannot carry a
  // button, and the whole point is to offer the chain right where it is refused.
  // Only offer it when every issue is waivable — a Telegram caption stays fatal.
  const parts = issues.every((item) => item.chainParts) ? Math.max(...issues.map((item) => item.chainParts ?? 0)) : 0;
  if (parts > 1) {
    const label = plural(locale, parts, {
      one: t(locale, "action.parts-one"),
      few: t(locale, "action.parts-few"),
      many: t(locale, "action.parts-many"),
    });
    const revision = getConversationState(backendDb, actorId, "post")?.revision;
    return [
      { type: "answer-callback" },
      {
        type: "prompt",
        text: t(locale, "action.preflight-chain", { label: issue.label, actual: issue.actual, limit: issue.limit, parts: label }),
        options: {
          reply_markup: new InlineKeyboard().text(
            t(locale, "action.preflight-chain-button", { parts: label }),
            publicationCallback("post", "threads_chain", [draftId], revision),
          ),
        },
        card: { kind: "post", draftId },
      },
    ];
  }
  return [
    {
      type: "toast",
      text: t(locale, "action.preflight", { label: issue.label, actual: issue.actual, limit: issue.limit }),
      showAlert: true,
    },
  ];
}

function previewEffects(
  backendDb: BackendDb,
  draftId: number,
  config: BackendConfig,
  view: DraftView = "overview",
  callbackText?: string,
): PublicationEffect[] {
  const preview = renderPublicationCard("post", { backendDb, config, publicationId: draftId, view });
  return [{ type: "answer-callback", ...(callbackText ? { text: callbackText } : {}) }, ...publicationCardEffect("post", draftId, preview)];
}

function promptEffect(
  backendDb: BackendDb,
  actorId: number,
  draftId: number,
  text: string,
  returnView: DraftView = "overview",
): PublicationEffect {
  const locale = botLocale(backendDb, actorId);
  const revision = getConversationState(backendDb, actorId, "post")?.revision;
  return {
    type: "prompt",
    text,
    options: {
      parse_mode: "Markdown",
      reply_markup: cancelPromptKeyboard(locale, publicationCallback("post", "cancel_state", [draftId, returnView]), revision),
    },
  };
}

function scheduledDraftText(
  locale: ReturnType<typeof botLocale>,
  draftId: number,
  postId: number,
  ruAt: Date | null,
  enAt: Date | null,
  config: BackendConfig,
): string {
  return `🟢 ${t(locale, "action.scheduled-as", { draftId, postId })}\nRU: ${formatMsk(ruAt, config)}\nEN: ${formatMsk(enAt, config)}`;
}

function savePostState(
  backendDb: BackendDb,
  actorId: number,
  step: PostWizardStep,
  draftId: number | null,
  controlMessageId: number | null,
): number {
  return saveConversationState(backendDb, actorId, {
    kind: "post",
    draftId,
    step: step.type,
    data:
      step.type === "edit_text" || step.type === "replace_media" || step.type === "schedule_manual"
        ? { locale: step.locale }
        : step.type === "schedule_confirm"
          ? { locale: step.locale, value: step.value.toISOString() }
          : {},
    controlMessageId,
  }).revision;
}

function requireScheduleLocale(value: string): "ru" | "en" {
  if (value === "ru" || value === "en") return value;
  throw new StudioError("err.unknown-scope");
}
