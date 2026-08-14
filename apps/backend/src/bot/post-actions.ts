import { InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import { StudioError } from "../foundation/errors.js";
import { plural, t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";
import { manualScheduleExample } from "../foundation/time.js";
import { settingsService } from "../studio/services/settings.js";
import { clearConversationState, getConversationState } from "./conversation-state.js";
import { cancelPromptKeyboard, resultNavigationKeyboard } from "./dialog-ui.js";
import type { PublicationEffect } from "./effects.js";
import { mainMenuText } from "./menu-render.js";
import { type PostWizardStep, postStateStep, postStepData } from "./post-flow.js";
import { showStoryCardChoice } from "./post-story-cards.js";
import { canEditLocale, type DraftView, modeLabel } from "./preview.js";
import { renderPostProgress } from "./progress.js";
import type {
  action,
  PublicationActionDefinition,
  PublicationActionResult,
  PublicationDraftActionContext,
} from "./publication-action-contract.js";
import { publicationCallback } from "./publication-callback.js";
import { openPublicationFlow } from "./publication-flow.js";
import { publicationCardEffect } from "./publication-renderers.js";
import { callbackMessageId } from "./telegram-context.js";

type PostActionArgs = PublicationDraftActionContext;
/** What `validate` answers with, taken from the service rather than from
 * Publishing: the bot reaches the pipeline through Studio, never around it. */
type PreflightIssue = ReturnType<PublicationDraftActionContext["services"]["posts"]["validate"]>[number];

export function definePostActionHandlers(define: typeof action): Record<string, PublicationActionDefinition> {
  return {
    toggle: define(handleToggle, { entity: "draft", freshCard: true, args: ["target"] }),
    cancel: define(handleCancel, { entity: "draft", freshCard: true, args: ["view"] }),
    cancel_confirm: define(handleCancelConfirm, { entity: "draft", freshCard: true, args: [] }),
    cancel_dialog: define(handleCancelDialog, { entity: "session", sessionRevision: true, args: [] }),
    cycle_mode: define(handleCycleMode, { entity: "draft", freshCard: true, args: [] }),
    edit_menu: define(handleEditMenu, { entity: "draft", freshCard: true, args: [] }),
    edit_ru: define(handleEdit, { entity: "draft", freshCard: true, args: [] }),
    edit_en: define(handleEdit, { entity: "draft", freshCard: true, args: [] }),
    edit_media_ru: define(handleEdit, { entity: "draft", freshCard: true, args: [] }),
    edit_media_en: define(handleEdit, { entity: "draft", freshCard: true, args: [] }),
    sources: define(handleSources, { entity: "draft", freshCard: true, args: [] }),
    schedule: define(handleSchedule, { entity: "draft", freshCard: true, args: [] }),
    sched_scope: define(handleScheduleScope, { entity: "draft", freshCard: true, args: ["scope"] }),
    sched_pick: define(handleSchedulePick, { entity: "draft", freshCard: true, args: ["axis", "clock"] }),
    sched_confirm: define(handleManualScheduleConfirm, { entity: "draft", freshCard: true, sessionRevision: true, args: [] }),
    sched_manual: define(handleManualSchedule, { entity: "draft", freshCard: true, args: ["axis"] }),
    story_publish_all: define(handleStoryChoice, { entity: "draft", freshCard: true, args: [] }),
    story_publish_site: define(handleStoryChoice, { entity: "draft", freshCard: true, args: [] }),
    story_schedule_all: define(handleStoryChoice, { entity: "draft", freshCard: true, args: [] }),
    story_schedule_site: define(handleStoryChoice, { entity: "draft", freshCard: true, args: [] }),
    threads_chain: define(handleThreadsChain, { entity: "draft", freshCard: true, args: [] }),
    publish: define(handlePublish, { entity: "draft", freshCard: true, args: [] }),
    publish_confirm: define(handlePublishConfirm, { entity: "draft", freshCard: true, args: [] }),
  };
}

const POST_INPUT_STEPS: Record<string, PostWizardStep> = {
  edit_ru: { type: "edit_text", locale: "ru" },
  edit_en: { type: "edit_text", locale: "en" },
  edit_media_ru: { type: "replace_media", locale: "ru" },
  edit_media_en: { type: "replace_media", locale: "en" },
};

async function handleCycleMode(args: PostActionArgs): Promise<PublicationActionResult> {
  const { actorId, locale, draftId, services } = args;
  const nextMode = services.posts.cycleMode(actorId, draftId);
  return previewEffects(args, "overview", `${t(locale, "post.mode")}: ${modeLabel(nextMode, locale)}`);
}

async function handleToggle(args: PostActionArgs): Promise<PublicationActionResult> {
  const target = args.args.target;
  if (!target) throw new StudioError("action.unknown");
  args.pipeline.toggleTarget(args.actorId, args.draftId, target);
  const card = args.renderer.card({
    actorId: args.actorId,
    publicationId: args.draftId,
    locale: args.locale,
    view: "platforms",
  });
  return [{ type: "toast", text: t(args.locale, "action.target-updated", { target }) }, ...publicationCardEffect(card)];
}

async function handleCancel(args: PostActionArgs): Promise<PublicationActionResult> {
  const card = args.renderer.card({
    actorId: args.actorId,
    publicationId: args.draftId,
    locale: args.locale,
    view: args.args.view ?? "confirm_cancel",
  });
  return publicationCardEffect(card);
}

async function handleCancelConfirm(args: PostActionArgs): Promise<PublicationActionResult> {
  const wasScheduled = args.pipeline.get(args.actorId, args.draftId).status === "scheduled";
  args.pipeline.cancel(args.actorId, args.draftId);
  return [
    { type: "toast", text: t(args.locale, "action.cancelled") },
    {
      type: "screen",
      mode: "edit",
      text: t(args.locale, wasScheduled ? "action.publication-cancelled" : "action.draft-cancelled", { id: args.draftId }),
      options: { reply_markup: resultNavigationKeyboard(args.locale, wasScheduled ? "upcoming" : "drafts") },
    },
  ];
}

async function handleCancelDialog(args: PostActionArgs): Promise<PublicationActionResult> {
  return [
    { type: "session", operation: "clear", kind: args.callback.kind, actorId: args.actorId },
    ...(args.mainMenu
      ? [{ type: "main-menu", menu: args.mainMenu, text: mainMenuText(args.backendDb, args.config, args.actorId), edit: true } as const]
      : []),
  ];
}

async function handleEdit({ ctx, backendDb, actorId, locale, action, draftId }: PostActionArgs): Promise<PublicationActionResult> {
  const step = POST_INPUT_STEPS[action];
  if (!step) throw new StudioError("action.session-stale");
  openPublicationFlow(backendDb, actorId, {
    kind: "post",
    draftId,
    step: step.type,
    data: postStepData(step),
    controlMessageId: callbackMessageId(ctx),
  });
  return [
    { type: "toast", text: t(locale, "action.send-replacement") },
    promptEffect(
      backendDb,
      actorId,
      step.type === "replace_media" ? t(locale, "action.send-new-media") : t(locale, "action.send-new-text"),
    ),
  ];
}

async function handleEditMenu({ backendDb, config, actorId, locale, draftId }: PostActionArgs): Promise<PublicationActionResult> {
  const keyboard = new InlineKeyboard();
  const addLocale = (targetLocale: "ru" | "en"): void => {
    if (!canEditLocale(backendDb, config, actorId, draftId, targetLocale)) return;
    if (targetLocale === "ru")
      keyboard
        .text(t(locale, "post.edit-ru"), publicationCallback("post", "edit_ru", [draftId]))
        .text(t(locale, "post.edit-media-ru"), publicationCallback("post", "edit_media_ru", [draftId]))
        .row();
    else
      keyboard
        .text(t(locale, "post.edit-en"), publicationCallback("post", "edit_en", [draftId]))
        .text(t(locale, "post.edit-media-en"), publicationCallback("post", "edit_media_en", [draftId]))
        .row();
  };
  addLocale("ru");
  addLocale("en");
  keyboard.text(t(locale, "post.edit-platforms"), publicationCallback("post", "view", [draftId, "platforms"])).row();
  keyboard.text(t(locale, "post.edit-sources"), publicationCallback("post", "sources", [draftId])).row();
  keyboard.text(t(locale, "common.back"), publicationCallback("post", "view", [draftId, "overview"]));
  return [
    {
      type: "screen",
      mode: "edit",
      text: t(locale, "post.what-to-edit"),
      options: { parse_mode: "Markdown", reply_markup: keyboard },
      card: { kind: "post", draftId },
    },
  ];
}

async function handleSources({ ctx, backendDb, actorId, locale, draftId }: PostActionArgs): Promise<PublicationActionResult> {
  openPublicationFlow(backendDb, actorId, {
    kind: "post",
    draftId,
    step: "edit_sources",
    data: {},
    controlMessageId: callbackMessageId(ctx),
  });
  return [promptEffect(backendDb, actorId, t(locale, "post.sources-prompt"))];
}

async function handlePublish(args: PostActionArgs): Promise<PublicationActionResult> {
  return showPublicationIntent(args, "publish");
}

async function handlePublishConfirm(args: PostActionArgs): Promise<PublicationActionResult> {
  return queuePostNow(args);
}

async function handleStoryChoice(args: PostActionArgs): Promise<PublicationActionResult> {
  const { actorId, action, draftId, services } = args;
  services.posts.setStoryPublishMode(actorId, draftId, action.endsWith("_all") ? "all" : "site_only");
  return action.startsWith("story_publish_") ? queuePostNow(args) : previewEffects(args, "schedule");
}

async function handleThreadsChain(args: PostActionArgs): Promise<PublicationActionResult> {
  const { ctx, backendDb, config, actorId, locale, draftId, services } = args;
  services.posts.approveThreadsChain(actorId, draftId);
  // The waiver only clears the Threads rule. Other preflight issues remain fatal.
  const preflight = await showPublicationPreflight(args);
  if (preflight) return preflight;
  const storyChoice = await showStoryCardChoice(ctx, backendDb, config, actorId, draftId, "publish");
  if (storyChoice) return storyChoice;
  return [{ type: "toast", text: t(locale, "action.preflight-chain-approved") }, ...sendPublishConfirmation(args)];
}

async function handleSchedule(args: PostActionArgs): Promise<PublicationActionResult> {
  const { backendDb, actorId, draftId, services } = args;
  clearConversationState(backendDb, actorId, "post");
  if (services.posts.get(actorId, draftId).status === "scheduled") return previewEffects(args, "schedule");
  return showPublicationIntent(args, "schedule");
}

async function showPublicationIntent(args: PostActionArgs, intent: "publish" | "schedule"): Promise<PublicationActionResult> {
  const { backendDb, config, actorId, draftId } = args;
  const preflight = await showPublicationPreflight(args);
  if (preflight) return preflight;
  const storyChoice = await showStoryCardChoice(args.ctx, backendDb, config, actorId, draftId, intent);
  if (storyChoice) return storyChoice;
  return intent === "publish" ? sendPublishConfirmation(args) : previewEffects(args, "schedule");
}

async function handleScheduleScope(args: PostActionArgs): Promise<PublicationActionResult> {
  const { backendDb, actorId, locale } = args;
  const scope = args.args.scope;
  if (!scope) return [{ type: "toast", text: t(locale, "action.unknown") }];
  clearConversationState(backendDb, actorId, "post");
  if (scope === "ru_now") return commitLocaleSchedule(args, "ru", new Date(), "ru");
  if (scope === "en_now") return commitLocaleSchedule(args, "en", new Date(), "en");
  if (scope === "both") return previewEffects(args, "schedule_ru");
  return [{ type: "toast", text: t(locale, "action.unknown") }];
}

async function handleSchedulePick(args: PostActionArgs): Promise<PublicationActionResult> {
  const { backendDb, actorId, locale, pipeline } = args;
  const axis = args.args.axis;
  const clock = args.args.clock;
  if (!axis || !clock) return [{ type: "toast", text: t(locale, "action.unknown") }];
  if (pipeline.capabilities.scheduleAxis !== "locale") throw new StudioError("action.schedule-expired");
  clearConversationState(backendDb, actorId, "post");
  const value = pipeline.slotTime(actorId, `${clock.slice(0, 2)}:${clock.slice(2, 4)}`);
  return commitLocaleSchedule(args, requireScheduleLocale(axis), value);
}

async function handleManualScheduleConfirm(args: PostActionArgs): Promise<PublicationActionResult> {
  const { backendDb, actorId, locale, draftId } = args;
  const state = getConversationState(backendDb, actorId, "post");
  const stateStep = postStateStep(state);
  if (stateStep?.type !== "schedule_confirm" || state?.draftId !== draftId)
    return [{ type: "toast", text: t(locale, "action.schedule-expired") }];
  const { locale: scope, value } = stateStep;
  clearConversationState(backendDb, actorId, "post");
  return commitLocaleSchedule(args, scope, value);
}

async function handleManualSchedule(args: PostActionArgs): Promise<PublicationActionResult> {
  const { ctx, backendDb, actorId, locale, draftId, config, services } = args;
  const axis = args.args.axis;
  if (!axis) return [{ type: "toast", text: t(locale, "action.unknown") }];
  const pickLocale = requireScheduleLocale(axis);
  clearConversationState(backendDb, actorId, "post");
  const timeConfig = services.settings.timeConfig(actorId, config);
  openPublicationFlow(backendDb, actorId, {
    kind: "post",
    draftId,
    step: "schedule_manual",
    data: { locale: pickLocale },
    controlMessageId: callbackMessageId(ctx),
  });
  return [
    { type: "toast", text: t(locale, "action.send-time") },
    promptEffect(
      backendDb,
      actorId,
      t(locale, "action.enter-datetime", {
        timezone: timeConfig.TIMEZONE_LABEL,
        example: manualScheduleExample(timeConfig.TIMEZONE, backendDb.clock.now()),
      }),
    ),
  ];
}

async function queuePostNow(args: PostActionArgs): Promise<PublicationActionResult> {
  const { services, actorId, draftId, locale } = args;
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
  args: PostActionArgs,
  scheduleLocale: "ru" | "en",
  value: Date,
  immediateLocale?: "ru" | "en",
): Promise<PublicationEffect[]> {
  const { services, backendDb, actorId, draftId } = args;
  const posts = services.posts;
  const { ruAt, enAt } = posts.scheduleAt(actorId, draftId, scheduleLocale, value);
  posts.schedule(actorId, draftId, {
    ruAt,
    enAt,
    ...(immediateLocale ? { immediateLocale } : {}),
  });
  const otherLocale = scheduleLocale === "ru" ? "en" : "ru";
  const otherAt = otherLocale === "ru" ? ruAt : enAt;
  const uiLocale = settingsService(backendDb).locale(actorId);
  if (!otherAt && posts.hasLocaleTargets(actorId, draftId, otherLocale)) {
    return previewEffects(args, otherLocale === "ru" ? "schedule_ru" : "schedule_en");
  }
  return [
    { type: "toast", text: t(uiLocale, "common.scheduled") },
    ...publicationCardEffect(
      args.renderer.card({
        actorId,
        publicationId: draftId,
        locale: uiLocale,
        view: "overview",
      }),
    ),
  ];
}

function sendPublishConfirmation(args: PostActionArgs): PublicationEffect[] {
  const { services, backendDb, actorId, draftId } = args;
  const delivery = services.posts.preview(actorId, draftId).delivery;
  const uiLocale = settingsService(backendDb).locale(actorId);
  const card = args.renderer.card({
    actorId,
    publicationId: draftId,
    locale: uiLocale,
    view: "confirm_publish",
  });
  return [
    { type: "delivery-previews", projections: delivery.projections, locale: uiLocale },
    ...publicationCardEffect(card, { type: "prompt" }),
  ];
}

async function showPublicationPreflight(args: PostActionArgs): Promise<PublicationEffect[] | null> {
  const { services, backendDb, actorId, draftId, locale } = args;
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
      {
        type: "prompt",
        text: t(locale, "action.preflight-chain", { label: issue.label, actual: issue.actual ?? 0, limit: issue.limit ?? 0, parts: label }),
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
  return [{ type: "toast", text: preflightToast(locale, issue), showAlert: true }];
}

/** A refusal an author can act on. The limit issues count characters; the
 * language and content ones name what is missing instead, and reading them
 * through the character template printed "undefined/undefined символов". */
function preflightToast(locale: StudioLocale, issue: PreflightIssue): string {
  if (issue.kind === "language")
    return t(locale, "action.preflight-language", {
      label: issue.label,
      expected: issue.locale.toUpperCase(),
      written: (issue.written ?? issue.locale).toUpperCase(),
    });
  if (issue.kind === "empty") return t(locale, "action.preflight-empty", { label: issue.label, expected: issue.locale.toUpperCase() });
  return t(locale, "action.preflight", { label: issue.label, actual: issue.actual ?? 0, limit: issue.limit ?? 0 });
}

function previewEffects(args: PostActionArgs, view: DraftView = "overview", callbackText?: string): PublicationEffect[] {
  const card = args.renderer.card({
    actorId: args.actorId,
    publicationId: args.draftId,
    locale: args.locale,
    view,
  });
  const ack: PublicationEffect[] = callbackText ? [{ type: "toast", text: callbackText }] : [];
  return [...ack, ...publicationCardEffect(card)];
}

function promptEffect(backendDb: BackendDb, actorId: number, text: string): PublicationEffect {
  const locale = settingsService(backendDb).locale(actorId);
  const revision = getConversationState(backendDb, actorId, "post")?.revision;
  return {
    type: "prompt",
    text,
    options: {
      parse_mode: "Markdown",
      reply_markup: cancelPromptKeyboard(locale, publicationCallback("post", "cancel_dialog", [], revision)),
    },
  };
}

function requireScheduleLocale(value: string): "ru" | "en" {
  if (value === "ru" || value === "en") return value;
  throw new StudioError("err.unknown-scope");
}
