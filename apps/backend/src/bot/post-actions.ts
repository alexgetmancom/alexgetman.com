import { type Context, InlineKeyboard, InputFile } from "grammy";
import type { BackendDb } from "../db/client.js";
import { withActionLock } from "../foundation/action-lock.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { plural, t } from "../foundation/i18n/index.js";
import { setTelegramPostCard, setTelegramPostProgressCard } from "../interfaces/telegram/control-cards.js";
import { sendTelegramDeliveryPreviews } from "../interfaces/telegram/delivery-previews.js";
import { formatMsk } from "../interfaces/telegram/time.js";
import { runStoryCardCycle } from "../story-cards/worker.js";
import { createStudioServices } from "../studio/services/index.js";
import { isStalePostCardCallback } from "./card-freshness.js";
import { botLocale } from "./i18n.js";
import { extractMessage } from "./message.js";
import { editDraftPreview, editDraftPrompt, sendDraftPreview, showScheduleConfirmation } from "./post-card.js";
import { clearPostAdminState, getPostAdminState, setPostAdminState } from "./post-state.js";
import { draftPreview, isDraftView, modeLabel } from "./preview.js";
import { renderPostProgress } from "./progress.js";

/** Applies a command selected on a text-post card. Telegram rendering lives in post-card. */
export async function handlePostAction(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const parts = data.split(":");
  const [action, first, second] = parts;
  // `sched_*` callbacks carry their scope arguments first and the draft id last;
  // every other callback puts the draft id immediately after the action name.
  const draftId = Number(action?.startsWith("sched_") ? parts.at(-1) : first);
  const actorId = Number(ctx.from?.id);
  const locale = botLocale(backendDb, actorId);
  if (!Number.isSafeInteger(draftId)) return void (await ctx.answerCallbackQuery({ text: t(locale, "action.invalid-post") }));
  if (isStalePostCardCallback(ctx, backendDb, action ?? "", draftId))
    return void (await ctx.answerCallbackQuery({ text: t(locale, "action.card-stale") }));
  const posts = createStudioServices(backendDb, config).posts;
  posts.get(actorId, draftId);
  if (action === "toggle" && second) {
    posts.toggleTarget(actorId, draftId, second);
    return editDraftPreview(ctx, backendDb, draftId, config, "platforms", t(locale, "action.target-updated", { target: second }));
  }
  if (action === "preview") return editDraftPreview(ctx, backendDb, draftId, config);
  if (action === "platforms") return editDraftPreview(ctx, backendDb, draftId, config, "platforms");
  if (action === "cycle_mode") {
    const nextMode = posts.cycleMode(actorId, draftId);
    return editDraftPreview(ctx, backendDb, draftId, config, "overview", `${t(locale, "post.mode")}: ${modeLabel(nextMode, locale)}`);
  }
  if (action === "cancel_state") {
    clearPostAdminState(backendDb, actorId);
    return editDraftPreview(ctx, backendDb, draftId, config, second && isDraftView(second) ? second : "overview");
  }
  if (["edit_ru", "edit_en", "replace_ru_media", "replace_en_media"].includes(action ?? "")) {
    if (!action) return;
    setPostAdminState(backendDb, actorId, action, draftId, callbackMessageId(ctx));
    await ctx.answerCallbackQuery({
      text: t(locale, "action.send-replacement"),
    });
    return editDraftPrompt(
      ctx,
      backendDb,
      draftId,
      action.startsWith("edit") ? t(locale, "action.send-new-text") : t(locale, "action.send-new-media"),
    );
  }
  if (action === "sources") {
    setPostAdminState(backendDb, actorId, "edit_sources", draftId, callbackMessageId(ctx));
    await ctx.answerCallbackQuery();
    return editDraftPrompt(ctx, backendDb, draftId, t(locale, "post.sources-prompt"));
  }
  if (action === "cancel") {
    return editDraftPreview(ctx, backendDb, draftId, config, "confirm_delete");
  }
  if (action === "cancel_confirm") {
    const result = await withActionLock(`${actorId}:${data}`, async () => {
      posts.cancel(actorId, draftId);
    });
    if (!result.ok) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery({ text: t(locale, "action.cancelled") });
    return void (await ctx.editMessageText(t(locale, "action.draft-cancelled", { id: draftId }), {
      reply_markup: new InlineKeyboard()
        .text(t(locale, "action.back-to-drafts"), "queue_drafts")
        .text(t(locale, "common.menu"), "menu_home"),
    }));
  }
  if (action === "publish") {
    if (await showPublicationPreflight(ctx, backendDb, config, actorId, draftId, locale)) return;
    if (await showStoryCardChoice(ctx, backendDb, config, actorId, draftId, "publish")) return;
    return sendPublishConfirmation(ctx, backendDb, config, actorId, draftId);
  }
  if (action === "story_publish_all" || action === "story_publish_site") {
    posts.setStoryPublishMode(actorId, draftId, action === "story_publish_all" ? "all" : "site_only");
    return queuePostNow(ctx, backendDb, config, actorId, draftId, data, locale);
  }
  if (action === "story_schedule_all" || action === "story_schedule_site") {
    posts.setStoryPublishMode(actorId, draftId, action === "story_schedule_all" ? "all" : "site_only");
    return editDraftPreview(ctx, backendDb, draftId, config, "schedule");
  }
  if (action === "threads_chain") {
    posts.approveThreadsChain(actorId, draftId);
    // The waiver only clears the Threads rule. Anything else preflight refuses —
    // a Telegram caption, say — must still stop the publication here.
    if (await showPublicationPreflight(ctx, backendDb, config, actorId, draftId, locale)) return;
    if (await showStoryCardChoice(ctx, backendDb, config, actorId, draftId, "publish")) return;
    await ctx.answerCallbackQuery({ text: t(locale, "action.preflight-chain-approved") });
    return sendPublishConfirmation(ctx, backendDb, config, actorId, draftId);
  }
  if (action === "publish_confirm") {
    return queuePostNow(ctx, backendDb, config, actorId, draftId, data, locale);
  }
  if (action === "schedule") {
    clearPostAdminState(backendDb, actorId);
    if (await showPublicationPreflight(ctx, backendDb, config, actorId, draftId, locale)) return;
    if (await showStoryCardChoice(ctx, backendDb, config, actorId, draftId, "schedule")) return;
    return editDraftPreview(ctx, backendDb, draftId, config, "schedule");
  }
  if (action === "sched_scope" && first) {
    clearPostAdminState(backendDb, actorId);
    if (first === "ru_now")
      return commitLocaleScheduleOnce(ctx, backendDb, config, actorId, draftId, "ru", new Date(Date.now() + 1_000), data);
    if (first === "en_now")
      return commitLocaleScheduleOnce(ctx, backendDb, config, actorId, draftId, "en", new Date(Date.now() + 1_000), data);
    if (first === "both") return editDraftPreview(ctx, backendDb, draftId, config, "schedule_ru");
    return void (await ctx.answerCallbackQuery({ text: t(locale, "action.unknown") }));
  }
  if (action === "sched_view" && first && isDraftView(first)) {
    clearPostAdminState(backendDb, actorId);
    return editDraftPreview(ctx, backendDb, draftId, config, first);
  }
  if (action === "sched_pick" && first && second) {
    clearPostAdminState(backendDb, actorId);
    const value = posts.slotTime(`${second.slice(0, 2)}:${second.slice(2, 4)}`);
    return commitLocaleScheduleOnce(ctx, backendDb, config, actorId, draftId, requireScheduleLocale(first), value, data);
  }
  if (action === "sched_manual_confirm") {
    const state = getPostAdminState(backendDb, actorId);
    const match = state?.action?.match(/^schedule_confirm_(ru|en)_(.+)$/);
    if (!match || state?.draft_id !== draftId)
      return void (await ctx.answerCallbackQuery({
        text: t(locale, "action.schedule-expired"),
      }));
    const scope = requireScheduleLocale(match[1] ?? "");
    const value = new Date(match[2] ?? "");
    if (Number.isNaN(value.getTime()))
      return void (await ctx.answerCallbackQuery({
        text: t(locale, "action.schedule-expired"),
      }));
    clearPostAdminState(backendDb, actorId);
    return commitLocaleScheduleOnce(ctx, backendDb, config, actorId, draftId, scope, value, `sched_manual_confirm:${draftId}`);
  }
  if (action === "sched_manual" && first) {
    const pickLocale = requireScheduleLocale(first);
    clearPostAdminState(backendDb, actorId);
    setPostAdminState(backendDb, actorId, `schedule_manual_${pickLocale}`, draftId, callbackMessageId(ctx));
    await ctx.answerCallbackQuery({ text: t(locale, "action.send-time") });
    return editDraftPrompt(
      ctx,
      backendDb,
      draftId,
      t(locale, "action.enter-datetime"),
      pickLocale === "ru" ? "schedule_ru" : "schedule_en",
    );
  }
  await ctx.answerCallbackQuery({ text: t(locale, "action.unknown") });
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
  const result = await withActionLock(`${actorId}:${actionKey}`, async () => {
    posts.publish(actorId, draftId);
  });
  if (!result.ok) return void (await ctx.answerCallbackQuery());
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
  let cards = posts.preview(actorId, draftId).storyCards;
  if (cards.length === 0) return false;
  const deadline = Date.now() + 4_000;
  while (!cardsReady(cards) && Date.now() < deadline) {
    await runStoryCardCycle(config, backendDb, draftId);
    cards = posts.preview(actorId, draftId).storyCards;
    if (!cardsReady(cards)) await Bun.sleep(100);
  }
  const locale = botLocale(backendDb, actorId);
  if (!cardsReady(cards)) {
    await ctx.answerCallbackQuery({ text: t(locale, "post.story-cards-generating"), show_alert: true });
    return true;
  }
  await ctx.answerCallbackQuery();
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
  await ctx.reply(t(locale, "post.story-cards-question"), { parse_mode: "Markdown", reply_markup: keyboard });
  return true;
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
): Promise<void> {
  const posts = createStudioServices(backendDb, config).posts;
  const { ruAt, enAt } = posts.scheduleAt(actorId, draftId, scheduleLocale, value);
  const postId = posts.schedule(actorId, draftId, { ruAt, enAt });
  const otherLocale = scheduleLocale === "ru" ? "en" : "ru";
  const otherAt = otherLocale === "ru" ? ruAt : enAt;
  const uiLocale = botLocale(backendDb, actorId);
  if (!otherAt && posts.hasLocaleTargets(actorId, draftId, otherLocale)) {
    return editDraftPreview(ctx, backendDb, draftId, config, otherLocale === "ru" ? "schedule_ru" : "schedule_en");
  }
  await ctx.answerCallbackQuery({ text: t(uiLocale, "common.scheduled") });
  await ctx.editMessageText(scheduledDraftText(uiLocale, draftId, postId, ruAt, enAt, config), {
    reply_markup: new InlineKeyboard().text(t(uiLocale, "queue.upcoming-btn"), "queue_home").text(t(uiLocale, "common.menu"), "menu_home"),
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
): Promise<void> {
  const result = await withActionLock(`${actorId}:${actionKey}`, () =>
    commitLocaleSchedule(ctx, backendDb, config, actorId, draftId, scheduleLocale, value),
  );
  if (!result.ok) await ctx.answerCallbackQuery();
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
  await ctx.reply(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
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
    await ctx.reply(t(locale, "action.preflight-chain", { label: issue.label, actual: issue.actual, limit: issue.limit, parts: label }), {
      reply_markup: new InlineKeyboard().text(t(locale, "action.preflight-chain-button", { parts: label }), `threads_chain:${draftId}`),
    });
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
): Promise<void> {
  const actorId = Number(ctx.from?.id);
  const message = extractMessage(ctx);
  if (action.startsWith("schedule_manual_")) {
    const scope = requireScheduleLocale(action.slice("schedule_manual_".length));
    const { ruAt, enAt } = createStudioServices(backendDb, config).posts.manualSchedule(actorId, draftId, scope, message.text);
    const value = scope === "ru" ? ruAt : enAt;
    if (!value) throw new StudioError("err.no-pub-time");
    setPostAdminState(backendDb, actorId, `schedule_confirm_${scope}_${value.toISOString()}`, draftId, controlMessageId);
    await sendPostPreviews(ctx, backendDb, config, actorId, draftId);
    return showScheduleConfirmation(
      ctx,
      backendDb,
      draftId,
      config,
      ruAt,
      enAt,
      `sched_manual_confirm:${draftId}`,
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
