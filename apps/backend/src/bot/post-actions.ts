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
import { type CallbackRouterContext, createCallbackRouter } from "./callback-router.js";
import { isStaleCardCallback, POST_CARD_FRESHNESS } from "./card-freshness.js";
import { resultNavigationKeyboard } from "./dialog-ui.js";
import { botLocale } from "./i18n.js";
import { extractMessage } from "./message.js";
import { editDraftPreview, editDraftPrompt, sendDraftPreview, showScheduleConfirmation } from "./post-card.js";
import { POST_ACTION_KEYS, type PostActionKey } from "./post-routes.js";
import { clearPostAdminState, getPostAdminState, requireCurrentPostSession, setPostAdminState } from "./post-state.js";
import { draftPreview, isDraftView, modeLabel } from "./preview.js";
import { renderPostProgress } from "./progress.js";
import { callbackAction, versionedCallback } from "./session-fsm.js";

type PostService = ReturnType<typeof createStudioServices>["posts"];
type PostActionArgs = Omit<CallbackRouterContext, "action"> & {
  action: PostActionKey;
  first: string | undefined;
  second: string | undefined;
  draftId: number;
  posts: PostService;
};
type PostActionHandler = (args: PostActionArgs) => Promise<void>;

const postRoutes: Record<PostActionKey, PostActionHandler> = {
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

/** Routed post callback names. The freshness guard and callback wiring test use
 * the same action vocabulary, so adding a button requires one map entry. */
export const postRouteKeys: readonly string[] = POST_ACTION_KEYS.filter((key) => key in postRoutes);

const postRouter = createCallbackRouter<PostActionArgs, number, void>({
  prefix: "",
  matches: (data) => POST_ACTION_KEYS.includes(callbackAction(data) as PostActionKey),
  routes: postRoutes,
  sessionBound: new Set(["cancel_state", "sched_manual_confirm"]),
  currentSessionRevision: ({ backendDb, actorId }) => getPostAdminState(backendDb, actorId)?.revision,
  parseEntity: (data, action) => {
    const parts = data.split(":");
    const draftId = Number(action.startsWith("sched_") ? parts.at(-1) : parts[1]);
    return Number.isSafeInteger(draftId) ? draftId : null;
  },
  buildArgs: (common, draftId) => ({
    ...common,
    action: common.action as PostActionKey,
    first: common.parts[1],
    second: common.parts[2],
    draftId: draftId as number,
    posts: createStudioServices(common.backendDb, common.config).posts,
  }),
  prepare: ({ backendDb, config, actorId }, draftId) => {
    createStudioServices(backendDb, config).posts.get(actorId, draftId as number);
  },
  isStale: ({ ctx, backendDb, data }) => isStaleCardCallback(ctx, backendDb, data, POST_CARD_FRESHNESS),
  invalidEntityText: (locale) => t(locale, "action.invalid-post"),
  staleText: (locale) => t(locale, "action.card-stale"),
  unknownText: (locale) => t(locale, "action.unknown"),
});

/** Applies a command selected on a text-post card. Telegram rendering lives in post-card. */
export async function handlePostAction(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<void> {
  await postRouter(ctx, backendDb, config);
}

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
  clearPostAdminState(backendDb, actorId);
  await editDraftPreview(ctx, backendDb, draftId, config, second && isDraftView(second) ? second : "overview");
}

async function handleEdit({ ctx, backendDb, actorId, locale, action, draftId }: PostActionArgs): Promise<void> {
  setPostAdminState(backendDb, actorId, action, draftId, callbackMessageId(ctx));
  await ctx.answerCallbackQuery({ text: t(locale, "action.send-replacement") });
  await editDraftPrompt(
    ctx,
    backendDb,
    draftId,
    action.startsWith("edit") ? t(locale, "action.send-new-text") : t(locale, "action.send-new-media"),
  );
}

async function handleSources({ ctx, backendDb, actorId, locale, draftId }: PostActionArgs): Promise<void> {
  setPostAdminState(backendDb, actorId, "edit_sources", draftId, callbackMessageId(ctx));
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
  clearPostAdminState(backendDb, actorId);
  if (await showPublicationPreflight(ctx, backendDb, config, actorId, draftId, locale)) return;
  if (await showStoryCardChoice(ctx, backendDb, config, actorId, draftId, "schedule")) return;
  await editDraftPreview(ctx, backendDb, draftId, config, "schedule");
}

async function handleScheduleScope({ ctx, backendDb, config, actorId, locale, first, draftId, data }: PostActionArgs): Promise<void> {
  if (!first) return void (await ctx.answerCallbackQuery({ text: t(locale, "action.unknown") }));
  clearPostAdminState(backendDb, actorId);
  if (first === "ru_now") return commitLocaleScheduleOnce(ctx, backendDb, config, actorId, draftId, "ru", new Date(), data, "ru");
  if (first === "en_now") return commitLocaleScheduleOnce(ctx, backendDb, config, actorId, draftId, "en", new Date(), data, "en");
  if (first === "both") return editDraftPreview(ctx, backendDb, draftId, config, "schedule_ru");
  await ctx.answerCallbackQuery({ text: t(locale, "action.unknown") });
}

async function handleScheduleView({ ctx, backendDb, config, actorId, first, draftId }: PostActionArgs): Promise<void> {
  if (!first || !isDraftView(first)) return;
  clearPostAdminState(backendDb, actorId);
  await editDraftPreview(ctx, backendDb, draftId, config, first);
}

async function handleSchedulePick({ ctx, backendDb, config, actorId, first, second, draftId, data, posts }: PostActionArgs): Promise<void> {
  if (!first || !second) return;
  clearPostAdminState(backendDb, actorId);
  const value = posts.slotTime(`${second.slice(0, 2)}:${second.slice(2, 4)}`);
  await commitLocaleScheduleOnce(ctx, backendDb, config, actorId, draftId, requireScheduleLocale(first), value, data);
}

async function handleManualScheduleConfirm({ ctx, backendDb, config, actorId, locale, draftId }: PostActionArgs): Promise<void> {
  const state = getPostAdminState(backendDb, actorId);
  const match = state?.action?.match(/^schedule_confirm_(ru|en)_(.+)$/);
  if (!match || state?.draft_id !== draftId) return void (await ctx.answerCallbackQuery({ text: t(locale, "action.schedule-expired") }));
  const scope = requireScheduleLocale(match[1] ?? "");
  const value = new Date(match[2] ?? "");
  if (Number.isNaN(value.getTime())) return void (await ctx.answerCallbackQuery({ text: t(locale, "action.schedule-expired") }));
  clearPostAdminState(backendDb, actorId);
  await commitLocaleScheduleOnce(ctx, backendDb, config, actorId, draftId, scope, value, `sched_manual_confirm:${draftId}`);
}

async function handleManualSchedule({ ctx, backendDb, config, actorId, locale, first, draftId }: PostActionArgs): Promise<void> {
  if (!first) return;
  const pickLocale = requireScheduleLocale(first);
  clearPostAdminState(backendDb, actorId);
  setPostAdminState(backendDb, actorId, `schedule_manual_${pickLocale}`, draftId, callbackMessageId(ctx));
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
    if (isStaleCardCallback(ctx, backendDb, `${intent === "publish" ? "publish" : "schedule"}:${draftId}`, POST_CARD_FRESHNESS)) return;
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
          .text(t(locale, "post.story-cards-all"), `story_publish_all:${draftId}`)
          .row()
          .text(t(locale, "post.story-cards-site-only"), `story_publish_site:${draftId}`)
          .row()
          .text(t(locale, "common.back"), `preview:${draftId}`)
      : new InlineKeyboard()
          .text(t(locale, "post.story-cards-all-schedule"), `story_schedule_all:${draftId}`)
          .row()
          .text(t(locale, "post.story-cards-site-only-schedule"), `story_schedule_site:${draftId}`)
          .row()
          .text(t(locale, "common.back"), `preview:${draftId}`);
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
    const revision = getPostAdminState(backendDb, actorId)?.revision;
    const message = await ctx.reply(
      t(locale, "action.preflight-chain", { label: issue.label, actual: issue.actual, limit: issue.limit, parts: label }),
      {
        reply_markup: new InlineKeyboard().text(
          t(locale, "action.preflight-chain-button", { parts: label }),
          versionedCallback(`threads_chain:${draftId}`, revision),
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
  action: string,
  draftId: number,
  controlMessageId: number | null,
  expectedRevision?: number | null,
): Promise<void> {
  const actorId = Number(ctx.from?.id);
  if (expectedRevision != null) requireCurrentPostSession(backendDb, actorId, expectedRevision);
  const message = extractMessage(ctx);
  if (action.startsWith("schedule_manual_")) {
    const scope = requireScheduleLocale(action.slice("schedule_manual_".length));
    const { ruAt, enAt } = createStudioServices(backendDb, config).posts.manualSchedule(actorId, draftId, scope, message.text);
    const value = scope === "ru" ? ruAt : enAt;
    if (!value) throw new StudioError("err.no-pub-time");
    const revision = setPostAdminState(backendDb, actorId, `schedule_confirm_${scope}_${value.toISOString()}`, draftId, controlMessageId);
    await sendPostPreviews(ctx, backendDb, config, actorId, draftId);
    return showScheduleConfirmation(
      ctx,
      backendDb,
      draftId,
      config,
      ruAt,
      enAt,
      versionedCallback(`sched_manual_confirm:${draftId}`, revision),
      scope === "ru" ? "schedule_ru" : "schedule_en",
    );
  } else if (action === "edit_ru" || action === "edit_en") {
    createStudioServices(backendDb, config).posts.edit(actorId, draftId, {
      locale: action === "edit_ru" ? "ru" : "en",
      text: message.text,
      entities: message.entities,
      media: message.media,
      clearMedia: isClearMediaCommand(message.text),
    });
  } else if (action === "replace_ru_media" || action === "replace_en_media") {
    createStudioServices(backendDb, config).posts.edit(actorId, draftId, {
      locale: action === "replace_ru_media" ? "ru" : "en",
      text: message.text,
      entities: message.entities,
      media: message.media,
      replaceMediaOnly: true,
    });
  } else if (action === "edit_sources") {
    const urls = extractUrls(message.text);
    if (urls.length === 0) throw new StudioError("err.no-valid-source-links");
    createStudioServices(backendDb, config).posts.replaceSources(actorId, draftId, urls);
  }
  clearPostAdminState(backendDb, actorId);
  // A completed edit gets a fresh card at the bottom, same as the album path
  // in albums.ts: the previous card is history to scroll back to, never a
  // moving prompt that erases what it looked like before the edit.
  const control = await sendDraftPreview(ctx, backendDb, draftId, config);
  if (ctx.chat?.id) setTelegramPostCard(backendDb, draftId, Number(ctx.chat.id), control.message_id);
}

/** Chat-only shorthand for clearing a post's media during a free-text edit reply. */
function isClearMediaCommand(text: string): boolean {
  const clean = text.trim().toLowerCase();
  return clean === "/delmedia" || clean === "очистить" || clean === "без медиа" || clean === "clear media";
}

function extractUrls(value: string): string[] {
  return value
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => {
      try {
        const url = new URL(item);
        return url.protocol === "https:" || url.protocol === "http:";
      } catch {
        return false;
      }
    });
}

async function sendPostPreviews(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
): Promise<void> {
  const delivery = createStudioServices(backendDb, config).posts.preview(actorId, draftId).delivery;
  await sendTelegramDeliveryPreviews(ctx, delivery.projections, botLocale(backendDb, actorId));
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

function requireScheduleLocale(value: string): "ru" | "en" {
  if (value === "ru" || value === "en") return value;
  throw new StudioError("err.unknown-scope");
}
