import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import { withActionLock } from "../foundation/action-lock.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { setTelegramPostCard, setTelegramPostProgressCard } from "../interfaces/telegram/control-cards.js";
import { sendTelegramDeliveryPreviews } from "../interfaces/telegram/delivery-previews.js";
import { t } from "../interfaces/telegram/i18n/index.js";
import { formatMsk } from "../interfaces/telegram/time.js";
import { studioServices } from "../studio/services/index.js";
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
  const draftId = Number(action === "preset" ? second : action?.startsWith("sched_") ? parts.at(-1) : first);
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  const actorId = Number(ctx.from?.id);
  if (!Number.isSafeInteger(draftId)) return void (await ctx.answerCallbackQuery({ text: t(locale, "action.invalid-post") }));
  studioServices(backendDb, config).posts.get(actorId, draftId);
  if (action === "toggle" && second) {
    studioServices(backendDb, config).posts.toggleTarget(actorId, draftId, second);
    await ctx.answerCallbackQuery({ text: t(locale, "action.target-updated", { target: second }) });
    return editDraftPreview(ctx, backendDb, draftId, config, "platforms");
  }
  if (action === "preview") return editDraftPreview(ctx, backendDb, draftId, config);
  if (action === "platforms") return editDraftPreview(ctx, backendDb, draftId, config, "platforms");
  if (action === "cycle_mode") {
    const nextMode = studioServices(backendDb, config).posts.cycleMode(actorId, draftId);
    await ctx.answerCallbackQuery({ text: `${t(locale, "post.mode")}: ${modeLabel(nextMode, locale)}` });
    return editDraftPreview(ctx, backendDb, draftId, config);
  }
  if (action === "cancel_state") {
    clearPostAdminState(backendDb, Number(ctx.from?.id));
    await ctx.answerCallbackQuery();
    return editDraftPreview(ctx, backendDb, draftId, config, second && isDraftView(second) ? second : "overview");
  }
  if (["edit_ru", "edit_en", "replace_ru_media", "replace_en_media"].includes(action ?? "")) {
    if (!action) return;
    setPostAdminState(backendDb, Number(ctx.from?.id), action, draftId, callbackMessageId(ctx));
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
    setPostAdminState(backendDb, Number(ctx.from?.id), "edit_sources", draftId, callbackMessageId(ctx));
    await ctx.answerCallbackQuery();
    return editDraftPrompt(
      ctx,
      backendDb,
      draftId,
      locale === "ru"
        ? "Пришли ссылки на источники одним сообщением. Можно по одной на строку. Новое сообщение заменит текущий список."
        : "Send source links in one message, one per line. A new message replaces the current list.",
    );
  }
  if (action === "cancel") {
    return editDraftPreview(ctx, backendDb, draftId, config, "confirm_delete");
  }
  if (action === "cancel_confirm") {
    const result = await withActionLock(`${actorId}:${data}`, async () => {
      studioServices(backendDb, config).posts.cancel(actorId, draftId);
    });
    if (!result.ok) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery({ text: t(locale, "action.cancelled") });
    return void (await ctx.editMessageText(t(locale, "action.draft-cancelled", { id: draftId }), {
      reply_markup: new InlineKeyboard().text(t(locale, "common.menu"), "menu_home"),
    }));
  }
  if (action === "publish") {
    if (await showPublicationPreflight(ctx, backendDb, config, actorId, draftId, locale)) return;
    const delivery = studioServices(backendDb, config).posts.preview(actorId, draftId).delivery;
    await sendTelegramDeliveryPreviews(ctx, delivery.projections, botLocale(backendDb, actorId));
    const preview = draftPreview(backendDb, draftId, config, "confirm_publish");
    await ctx.reply(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
    return;
  }
  if (action === "publish_confirm") {
    const result = await withActionLock(`${actorId}:${data}`, async () => {
      studioServices(backendDb, config).posts.publish(actorId, draftId);
    });
    if (!result.ok) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery({ text: t(locale, "action.queued") });
    await ctx.editMessageText(t(locale, "action.post-queued", { id: draftId }));
    const progress = renderPostProgress(studioServices(backendDb, config).posts.progress(actorId, draftId), locale);
    const message = await ctx.reply(progress.text, { parse_mode: "Markdown", reply_markup: progress.keyboard });
    if (ctx.chat?.id) setTelegramPostProgressCard(backendDb, draftId, Number(ctx.chat.id), message.message_id);
    return;
  }
  if (action === "schedule") {
    if (await showPublicationPreflight(ctx, backendDb, config, actorId, draftId, locale)) return;
    return editDraftPreview(ctx, backendDb, draftId, config, "schedule");
  }
  if (action === "sched_scope" && first) {
    if (first === "ru_now") return commitLocaleSchedule(ctx, backendDb, config, actorId, draftId, "ru", new Date());
    if (first === "en_now") return commitLocaleSchedule(ctx, backendDb, config, actorId, draftId, "en", new Date());
    if (first === "both") return editDraftPreview(ctx, backendDb, draftId, config, "schedule_ru");
    return void (await ctx.answerCallbackQuery({ text: t(locale, "action.unknown") }));
  }
  if (action === "sched_view" && first && isDraftView(first)) return editDraftPreview(ctx, backendDb, draftId, config, first);
  if (action === "sched_pick" && first && second) {
    const value = studioServices(backendDb, config).posts.slotTime(`${second.slice(0, 2)}:${second.slice(2, 4)}`);
    return commitLocaleSchedule(ctx, backendDb, config, actorId, draftId, requireScheduleLocale(first), value);
  }
  if (action === "sched_auto" && first) {
    const pickLocale = requireScheduleLocale(first);
    const value = studioServices(backendDb, config).posts.autoSlot(actorId, draftId, pickLocale);
    return commitLocaleSchedule(ctx, backendDb, config, actorId, draftId, pickLocale, value);
  }
  if (action === "sched_manual_confirm") {
    const state = getPostAdminState(backendDb, Number(ctx.from?.id));
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
    clearPostAdminState(backendDb, Number(ctx.from?.id));
    const result = await withActionLock(`${actorId}:sched_manual_confirm:${draftId}`, () =>
      commitLocaleSchedule(ctx, backendDb, config, actorId, draftId, scope, value),
    );
    if (!result.ok) return void (await ctx.answerCallbackQuery());
    return;
  }
  if (action === "sched_manual" && first) {
    const pickLocale = requireScheduleLocale(first);
    setPostAdminState(backendDb, Number(ctx.from?.id), `schedule_manual_${pickLocale}`, draftId, callbackMessageId(ctx));
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
  const posts = studioServices(backendDb, config).posts;
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
    reply_markup: new InlineKeyboard().text(t(uiLocale, "common.menu"), "menu_home"),
  });
}

async function showPublicationPreflight(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  locale: ReturnType<typeof botLocale>,
): Promise<boolean> {
  const issue = studioServices(backendDb, config).posts.validate(actorId, draftId)[0];
  if (!issue) return false;
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
  const message = extractMessage(ctx);
  if (action.startsWith("schedule_manual_")) {
    const scope = requireScheduleLocale(action.slice("schedule_manual_".length));
    const { ruAt, enAt } = studioServices(backendDb, config).posts.manualSchedule(Number(ctx.from?.id), draftId, scope, message.text);
    const value = scope === "ru" ? ruAt : enAt;
    if (!value) throw new StudioError("err.no-pub-time");
    setPostAdminState(backendDb, Number(ctx.from?.id), `schedule_confirm_${scope}_${value.toISOString()}`, draftId, controlMessageId);
    await sendPostPreviews(ctx, backendDb, config, Number(ctx.from?.id), draftId);
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
    studioServices(backendDb, config).posts.edit(Number(ctx.from?.id), draftId, {
      locale: action === "edit_ru" ? "ru" : "en",
      text: message.text,
      entities: message.entities,
      media: message.media,
    });
  } else if (action === "replace_ru_media" || action === "replace_en_media") {
    studioServices(backendDb, config).posts.edit(Number(ctx.from?.id), draftId, {
      locale: action === "replace_ru_media" ? "ru" : "en",
      text: message.text,
      entities: message.entities,
      media: message.media,
      replaceMediaOnly: true,
    });
  } else if (action === "edit_sources") {
    const urls = extractUrls(message.text);
    if (urls.length === 0) throw new StudioError("Send at least one valid http(s) link.");
    studioServices(backendDb, config).posts.replaceSources(Number(ctx.from?.id), draftId, urls);
  }
  clearPostAdminState(backendDb, Number(ctx.from?.id));
  // A completed edit gets a fresh card at the bottom, same as the album path
  // in albums.ts: the previous card is history to scroll back to, never a
  // moving prompt that erases what it looked like before the edit.
  const control = await sendDraftPreview(ctx, backendDb, draftId, config);
  if (ctx.chat?.id) setTelegramPostCard(backendDb, draftId, Number(ctx.chat.id), control.message_id);
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
  const delivery = studioServices(backendDb, config).posts.preview(actorId, draftId).delivery;
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
