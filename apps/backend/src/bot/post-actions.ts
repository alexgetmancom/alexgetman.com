import { type Context, InlineKeyboard, InputFile } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { plural, t } from "../foundation/i18n/index.js";
import { log } from "../foundation/logger.js";
import { setTelegramPostCard, setTelegramPostProgressCard } from "../interfaces/telegram/control-cards.js";
import { sendTelegramDeliveryPreviews } from "../interfaces/telegram/delivery-previews.js";
import { formatMsk } from "../interfaces/telegram/time.js";
import { createStudioServices } from "../studio/services/index.js";
import { withCallbackActionLock } from "./callback-action.js";
import type { PublicationActionContext } from "./callback-router.js";
import { isStaleCardCallback, PUBLICATION_CARD_FRESHNESS } from "./card-freshness.js";
import { clearConversationState, getConversationState, requireConversationState, saveConversationState } from "./conversation-state.js";
import { resultNavigationKeyboard } from "./dialog-ui.js";
import { botLocale } from "./i18n.js";
import { extractMessage } from "./message.js";
import { editDraftPreview, editDraftPrompt, sendDraftPreview } from "./post-card.js";
import { acceptPostFlowStep, type PostWizardStep, postStateStep, postStepData, postStepName } from "./post-fsm.js";
import { draftPreview, isDraftView, modeLabel } from "./preview.js";
import { renderPostProgress } from "./progress.js";
import { type PostActionKey, publicationCallback } from "./session-fsm.js";

type PostActionArgs = PublicationActionContext;
type PostActionHandler = (args: PostActionArgs) => Promise<void>;

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
  story_publish_all: handleStoryPublish,
  story_publish_site: handleStoryPublish,
  story_schedule_all: handleStorySchedule,
  story_schedule_site: handleStorySchedule,
  threads_chain: handleThreadsChain,
  publish_confirm: handlePublishConfirm,
  schedule: handleSchedule,
  sched_scope: handleScheduleScope,
  sched_view: handleScheduleView,
  sched_pick: handleSchedulePick,
  sched_manual_confirm: handleManualScheduleConfirm,
  sched_manual: handleManualSchedule,
};

const POST_INPUT_STEPS: Record<string, PostWizardStep> = {
  edit_ru: { type: "edit_text", locale: "ru" },
  edit_en: { type: "edit_text", locale: "en" },
  replace_ru_media: { type: "replace_media", locale: "ru" },
  replace_en_media: { type: "replace_media", locale: "en" },
};

async function handleToggle({ ctx, backendDb, config, actorId, locale, second, draftId, posts }: PostActionArgs): Promise<void> {
  if (!second) return void (await ctx.answerCallbackQuery({ text: t(locale, "action.unknown") }));
  posts.toggleTarget(actorId, draftId, second);
  await editDraftPreview(ctx, backendDb, draftId, config, "platforms", t(locale, "action.target-updated", { target: second }));
}

async function handlePreview({ ctx, backendDb, config, draftId }: PostActionArgs): Promise<void> {
  await editDraftPreview(ctx, backendDb, draftId, config);
}

async function handlePlatforms({ ctx, backendDb, config, draftId }: PostActionArgs): Promise<void> {
  await editDraftPreview(ctx, backendDb, draftId, config, "platforms");
}

async function handleCycleMode({ ctx, backendDb, config, actorId, locale, draftId, posts }: PostActionArgs): Promise<void> {
  const nextMode = posts.cycleMode(actorId, draftId);
  await editDraftPreview(ctx, backendDb, draftId, config, "overview", `${t(locale, "post.mode")}: ${modeLabel(nextMode, locale)}`);
}

async function handleCancelState({ ctx, backendDb, config, actorId, second, draftId }: PostActionArgs): Promise<void> {
  clearConversationState(backendDb, actorId, "post");
  await editDraftPreview(ctx, backendDb, draftId, config, second && isDraftView(second) ? second : "overview");
}

async function handleEdit({ ctx, backendDb, actorId, locale, action, draftId }: PostActionArgs): Promise<void> {
  const step = POST_INPUT_STEPS[action];
  if (!step) throw new StudioError("action.session-stale");
  savePostState(backendDb, actorId, step, draftId, callbackMessageId(ctx));
  await ctx.answerCallbackQuery({ text: t(locale, "action.send-replacement") });
  await editDraftPrompt(
    ctx,
    backendDb,
    draftId,
    action.startsWith("edit") ? t(locale, "action.send-new-text") : t(locale, "action.send-new-media"),
  );
}

async function handleSources({ ctx, backendDb, actorId, locale, draftId }: PostActionArgs): Promise<void> {
  savePostState(backendDb, actorId, { type: "edit_sources" }, draftId, callbackMessageId(ctx));
  await ctx.answerCallbackQuery();
  await editDraftPrompt(ctx, backendDb, draftId, t(locale, "post.sources-prompt"));
}

async function handleCancel({ ctx, backendDb, config, draftId }: PostActionArgs): Promise<void> {
  await editDraftPreview(ctx, backendDb, draftId, config, "confirm_delete");
}

async function handleCancelConfirm({ ctx, actorId, locale, draftId, data, posts }: PostActionArgs): Promise<void> {
  const result = await withCallbackActionLock(ctx, `${actorId}:${data}`, async () => posts.cancel(actorId, draftId));
  if (!result.ok) return;
  await ctx.answerCallbackQuery({ text: t(locale, "action.cancelled") });
  await ctx.editMessageText(t(locale, "action.draft-cancelled", { id: draftId }), {
    reply_markup: resultNavigationKeyboard(locale, "drafts"),
  });
}

async function handleRetry({
  ctx,
  backendDb,
  config,
  actorId,
  locale,
  action,
  second,
  draftId,
  data,
  posts,
}: PostActionArgs): Promise<void> {
  const result = await withCallbackActionLock(ctx, `${actorId}:${data}`, async () =>
    posts.retryFailed(actorId, draftId, second || undefined),
  );
  if (!result.ok) return;
  await ctx.answerCallbackQuery({
    text: t(locale, "action.retry-result", { requeued: result.value.requeued, alreadyQueued: result.value.alreadyQueued }),
  });
  if (action !== "post_retry") return;
  const preview = draftPreview(backendDb, draftId, config);
  await ctx.editMessageText(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
  const messageId = callbackMessageId(ctx);
  if (ctx.chat?.id != null && messageId != null) setTelegramPostCard(backendDb, draftId, ctx.chat.id, messageId);
}

async function handlePublish(args: PostActionArgs): Promise<void> {
  const { ctx, backendDb, config, actorId, locale, draftId } = args;
  if (await showPublicationPreflight(ctx, backendDb, config, actorId, draftId, locale)) return;
  if (await showStoryCardChoice(ctx, backendDb, config, actorId, draftId, "publish")) return;
  await sendPublishConfirmation(ctx, backendDb, config, actorId, draftId);
}

async function handleStoryPublish({
  ctx,
  backendDb,
  config,
  actorId,
  locale,
  action,
  draftId,
  data,
  posts,
}: PostActionArgs): Promise<void> {
  posts.setStoryPublishMode(actorId, draftId, action === "story_publish_all" ? "all" : "site_only");
  await queuePostNow(ctx, backendDb, config, actorId, draftId, data, locale);
}

async function handleStorySchedule({ ctx, backendDb, config, actorId, action, draftId, posts }: PostActionArgs): Promise<void> {
  posts.setStoryPublishMode(actorId, draftId, action === "story_schedule_all" ? "all" : "site_only");
  await editDraftPreview(ctx, backendDb, draftId, config, "schedule");
}

async function handleThreadsChain({ ctx, backendDb, config, actorId, locale, draftId, posts }: PostActionArgs): Promise<void> {
  posts.approveThreadsChain(actorId, draftId);
  // The waiver only clears the Threads rule. Other preflight issues remain fatal.
  if (await showPublicationPreflight(ctx, backendDb, config, actorId, draftId, locale)) return;
  if (await showStoryCardChoice(ctx, backendDb, config, actorId, draftId, "publish")) return;
  await ctx.answerCallbackQuery({ text: t(locale, "action.preflight-chain-approved") });
  await sendPublishConfirmation(ctx, backendDb, config, actorId, draftId);
}

async function handlePublishConfirm({ ctx, backendDb, config, actorId, locale, draftId, data }: PostActionArgs): Promise<void> {
  await queuePostNow(ctx, backendDb, config, actorId, draftId, data, locale);
}

async function handleSchedule(args: PostActionArgs): Promise<void> {
  const { ctx, backendDb, config, actorId, locale, draftId } = args;
  clearConversationState(backendDb, actorId, "post");
  if (await showPublicationPreflight(ctx, backendDb, config, actorId, draftId, locale)) return;
  if (await showStoryCardChoice(ctx, backendDb, config, actorId, draftId, "schedule")) return;
  await editDraftPreview(ctx, backendDb, draftId, config, "schedule");
}

async function handleScheduleScope({ ctx, backendDb, config, actorId, locale, first, draftId, data }: PostActionArgs): Promise<void> {
  if (!first) return void (await ctx.answerCallbackQuery({ text: t(locale, "action.unknown") }));
  clearConversationState(backendDb, actorId, "post");
  if (first === "ru_now") return commitLocaleScheduleOnce(ctx, backendDb, config, actorId, draftId, "ru", new Date(), data, "ru");
  if (first === "en_now") return commitLocaleScheduleOnce(ctx, backendDb, config, actorId, draftId, "en", new Date(), data, "en");
  if (first === "both") return editDraftPreview(ctx, backendDb, draftId, config, "schedule_ru");
  await ctx.answerCallbackQuery({ text: t(locale, "action.unknown") });
}

async function handleScheduleView({ ctx, backendDb, config, actorId, first, draftId }: PostActionArgs): Promise<void> {
  if (!first || !isDraftView(first)) return;
  clearConversationState(backendDb, actorId, "post");
  await editDraftPreview(ctx, backendDb, draftId, config, first);
}

async function handleSchedulePick({ ctx, backendDb, config, actorId, first, second, draftId, data, posts }: PostActionArgs): Promise<void> {
  if (!first || !second) return;
  clearConversationState(backendDb, actorId, "post");
  const value = posts.slotTime(`${second.slice(0, 2)}:${second.slice(2, 4)}`);
  await commitLocaleScheduleOnce(ctx, backendDb, config, actorId, draftId, requireScheduleLocale(first), value, data);
}

async function handleManualScheduleConfirm({ ctx, backendDb, config, actorId, locale, draftId }: PostActionArgs): Promise<void> {
  const state = getConversationState(backendDb, actorId, "post");
  const stateStep = postStateStep(state);
  if (stateStep?.type !== "schedule_confirm" || state?.draftId !== draftId)
    return void (await ctx.answerCallbackQuery({ text: t(locale, "action.schedule-expired") }));
  const { locale: scope, value } = stateStep;
  clearConversationState(backendDb, actorId, "post");
  await commitLocaleScheduleOnce(ctx, backendDb, config, actorId, draftId, scope, value, `sched_manual_confirm:${draftId}`);
}

async function handleManualSchedule({ ctx, backendDb, config, actorId, locale, first, draftId }: PostActionArgs): Promise<void> {
  if (!first) return;
  const pickLocale = requireScheduleLocale(first);
  clearConversationState(backendDb, actorId, "post");
  savePostState(backendDb, actorId, { type: "schedule_manual", locale: pickLocale }, draftId, callbackMessageId(ctx));
  await ctx.answerCallbackQuery({ text: t(locale, "action.send-time") });
  await editDraftPrompt(
    ctx,
    backendDb,
    draftId,
    t(locale, "action.enter-datetime", { timezone: config.TIMEZONE_LABEL }),
    pickLocale === "ru" ? "schedule_ru" : "schedule_en",
  );
}

async function queuePostNow(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  actionKey: string,
  locale: ReturnType<typeof botLocale>,
): Promise<void> {
  const posts = createStudioServices(backendDb, config).posts;
  const result = await withCallbackActionLock(ctx, `${actorId}:${actionKey}`, async () => {
    posts.publish(actorId, draftId);
  });
  if (!result.ok) return;
  await ctx.answerCallbackQuery({ text: t(locale, "action.queued") });
  await ctx.editMessageText(t(locale, "action.post-queued", { id: draftId }));
  const progress = renderPostProgress(posts.progress(actorId, draftId), locale);
  const message = await ctx.reply(progress.text, { parse_mode: "Markdown", reply_markup: progress.keyboard });
  if (ctx.chat?.id) setTelegramPostProgressCard(backendDb, draftId, Number(ctx.chat.id), message.message_id);
}

async function showStoryCardChoice(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  intent: "publish" | "schedule",
): Promise<boolean> {
  const posts = createStudioServices(backendDb, config).posts;
  const cards = posts.preview(actorId, draftId).storyCards;
  if (cards.length === 0) return false;
  const locale = botLocale(backendDb, actorId);
  if (!cardsReady(cards)) {
    await ctx.answerCallbackQuery({ text: t(locale, "post.story-cards-generating") });
    queueStoryCardChoice(ctx, backendDb, config, actorId, draftId, intent);
    return true;
  }
  await ctx.answerCallbackQuery();
  await sendStoryCardChoice(ctx, backendDb, actorId, draftId, intent, cards);
  return true;
}

const pendingStoryCardChoices = new Map<string, Promise<void>>();

/** The Story worker owns rendering. This lightweight continuation only waits
 * for its durable result and sends the choice as a follow-up Telegram message. */
function queueStoryCardChoice(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  intent: "publish" | "schedule",
): void {
  const key = `${actorId}:${draftId}:${intent}`;
  if (pendingStoryCardChoices.has(key)) return;
  const task = waitForStoryCards(ctx, backendDb, config, actorId, draftId, intent).finally(() => pendingStoryCardChoices.delete(key));
  pendingStoryCardChoices.set(key, task);
  void task.catch((error) => {
    logStoryCardChoiceFailure(error, actorId, draftId);
  });
}

async function waitForStoryCards(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  intent: "publish" | "schedule",
): Promise<void> {
  const posts = createStudioServices(backendDb, config).posts;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await delay(1_000);
    const cards = posts.preview(actorId, draftId).storyCards;
    if (!cardsReady(cards)) continue;
    if (
      isStaleCardCallback(
        ctx,
        backendDb,
        { kind: "post", action: intent === "publish" ? "publish" : "schedule", args: [String(draftId)] },
        PUBLICATION_CARD_FRESHNESS,
      )
    )
      return;
    await sendStoryCardChoice(ctx, backendDb, actorId, draftId, intent, cards);
    return;
  }
}

async function sendStoryCardChoice(
  ctx: Context,
  backendDb: BackendDb,
  actorId: number,
  draftId: number,
  intent: "publish" | "schedule",
  cards: Array<{ locale: string; status: string; localPath: string | null }>,
): Promise<void> {
  const locale = botLocale(backendDb, actorId);
  for (const cardLocale of ["ru", "en"] as const) {
    const card = cards.find((item) => item.locale === cardLocale);
    if (card?.localPath) await ctx.replyWithPhoto(new InputFile(card.localPath), { caption: `Story · ${cardLocale.toUpperCase()}` });
  }
  const keyboard =
    intent === "publish"
      ? new InlineKeyboard()
          .text(t(locale, "post.story-cards-all"), publicationCallback("post", "story_publish_all", [draftId]))
          .row()
          .text(t(locale, "post.story-cards-site-only"), publicationCallback("post", "story_publish_site", [draftId]))
          .row()
          .text(t(locale, "common.back"), publicationCallback("post", "preview", [draftId]))
      : new InlineKeyboard()
          .text(t(locale, "post.story-cards-all-schedule"), publicationCallback("post", "story_schedule_all", [draftId]))
          .row()
          .text(t(locale, "post.story-cards-site-only-schedule"), publicationCallback("post", "story_schedule_site", [draftId]))
          .row()
          .text(t(locale, "common.back"), publicationCallback("post", "preview", [draftId]));
  const message = await ctx.reply(t(locale, "post.story-cards-question"), { parse_mode: "Markdown", reply_markup: keyboard });
  if (ctx.chat?.id != null) setTelegramPostCard(backendDb, draftId, ctx.chat.id, message.message_id);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function logStoryCardChoiceFailure(error: unknown, actorId: number, draftId: number): void {
  log("error", "failed to send Story card choice", {
    actorId,
    draftId,
    error: error instanceof Error ? error.message : String(error),
  });
}

function cardsReady(cards: Array<{ locale: string; status: string; localPath: string | null }>): boolean {
  return ["ru", "en"].every((locale) => cards.some((card) => card.locale === locale && card.status === "ready" && card.localPath));
}

/** Commits one locale's schedule immediately (button/auto pick, or "now"). If
 * the other locale still needs a time and has enabled targets, hands off to
 * its slot screen instead of finishing; otherwise shows the final result. */
async function commitLocaleSchedule(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  scheduleLocale: "ru" | "en",
  value: Date,
  immediateLocale?: "ru" | "en",
): Promise<void> {
  const posts = createStudioServices(backendDb, config).posts;
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
    return editDraftPreview(ctx, backendDb, draftId, config, otherLocale === "ru" ? "schedule_ru" : "schedule_en");
  }
  await ctx.answerCallbackQuery({ text: t(uiLocale, "common.scheduled") });
  await ctx.editMessageText(scheduledDraftText(uiLocale, draftId, postId, ruAt, enAt, config), {
    reply_markup: resultNavigationKeyboard(uiLocale, "upcoming"),
  });
}

async function commitLocaleScheduleOnce(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  scheduleLocale: "ru" | "en",
  value: Date,
  actionKey: string,
  immediateLocale?: "ru" | "en",
): Promise<void> {
  const result = await withCallbackActionLock(ctx, `${actorId}:${actionKey}`, () =>
    commitLocaleSchedule(ctx, backendDb, config, actorId, draftId, scheduleLocale, value, immediateLocale),
  );
  if (!result.ok) return;
}

async function sendPublishConfirmation(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
): Promise<void> {
  const delivery = createStudioServices(backendDb, config).posts.preview(actorId, draftId).delivery;
  await sendTelegramDeliveryPreviews(ctx, delivery.projections, botLocale(backendDb, actorId));
  const preview = draftPreview(backendDb, draftId, config, "confirm_publish");
  const message = await ctx.reply(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
  if (ctx.chat?.id != null) setTelegramPostCard(backendDb, draftId, ctx.chat.id, message.message_id);
}

async function showPublicationPreflight(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  locale: ReturnType<typeof botLocale>,
): Promise<boolean> {
  const issues = createStudioServices(backendDb, config).posts.validate(actorId, draftId);
  const issue = issues[0];
  if (!issue) return false;
  // A waivable issue needs a message, not an alert: an alert cannot carry a
  // button, and the whole point is to offer the chain right where it is refused.
  // Only offer it when every issue is waivable — a Telegram caption stays fatal.
  const parts = issues.every((item) => item.chainParts) ? Math.max(...issues.map((item) => item.chainParts ?? 0)) : 0;
  if (parts > 1) {
    await ctx.answerCallbackQuery();
    const label = plural(locale, parts, {
      one: t(locale, "action.parts-one"),
      few: t(locale, "action.parts-few"),
      many: t(locale, "action.parts-many"),
    });
    const revision = getConversationState(backendDb, actorId, "post")?.revision;
    const message = await ctx.reply(
      t(locale, "action.preflight-chain", { label: issue.label, actual: issue.actual, limit: issue.limit, parts: label }),
      {
        reply_markup: new InlineKeyboard().text(
          t(locale, "action.preflight-chain-button", { parts: label }),
          publicationCallback("post", "threads_chain", [draftId], revision),
        ),
      },
    );
    if (ctx.chat?.id != null) setTelegramPostCard(backendDb, draftId, ctx.chat.id, message.message_id);
    return true;
  }
  await ctx.answerCallbackQuery({
    text: t(locale, "action.preflight", { label: issue.label, actual: issue.actual, limit: issue.limit }),
    show_alert: true,
  });
  return true;
}

export async function applyAdminState(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  step: PostWizardStep,
  draftId: number,
  controlMessageId: number | null,
  expectedRevision?: number | null,
): Promise<void> {
  const actorId = Number(ctx.from?.id);
  if (expectedRevision != null) requireConversationState(backendDb, actorId, "post", expectedRevision);
  const message = extractMessage(ctx);
  const transition = await acceptPostFlowStep(step, { ctx, backendDb, config, actorId, draftId, controlMessageId, step, message }, {});
  if (!transition) throw new StudioError("action.session-stale");
  if (transition.next === null) {
    clearConversationState(backendDb, actorId, "post");
    const control = await sendDraftPreview(ctx, backendDb, draftId, config);
    if (ctx.chat?.id) setTelegramPostCard(backendDb, draftId, Number(ctx.chat.id), control.message_id);
  }
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

function callbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  return message && "message_id" in message ? message.message_id : null;
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
    step: postStepName(step),
    data: postStepData(step),
    controlMessageId,
  }).revision;
}

function requireScheduleLocale(value: string): "ru" | "en" {
  if (value === "ru" || value === "en") return value;
  throw new StudioError("err.unknown-scope");
}
