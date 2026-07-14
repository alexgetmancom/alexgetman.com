import type { Context } from "grammy";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { formatMsk } from "../interfaces/telegram/time.js";
import { studioServices } from "../studio/services/index.js";
import { botLocale, ui } from "./i18n.js";
import { extractMessage } from "./message.js";
import { editDraftPreview, editDraftPrompt, sendDraftPreview, showScheduleConfirmation } from "./post-card.js";
import { clearPostAdminState, getPostAdminState, setPostAdminState } from "./post-state.js";
import { draftPreview, modeLabel } from "./preview.js";
import { renderPostProgress } from "./progress.js";

/** Applies a command selected on a text-post card. Telegram rendering lives in post-card. */
export async function handlePostAction(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const parts = data.split(":");
  const [action, first, second] = parts;
  const draftId = Number(action === "preset" ? second : action?.startsWith("sched_") ? parts.at(-1) : first);
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  const actorId = Number(ctx.from?.id);
  if (!Number.isSafeInteger(draftId))
    return void (await ctx.answerCallbackQuery({ text: ui(locale, "Invalid post", "Некорректный пост") }));
  studioServices(backendDb, config).posts.details(actorId, draftId);
  if (action === "toggle" && second) {
    studioServices(backendDb, config).posts.toggleTarget(actorId, draftId, second);
    await ctx.answerCallbackQuery({ text: ui(locale, `${second} updated`, `${second}: обновлено`) });
    return editDraftPreview(ctx, backendDb, draftId, "platforms");
  }
  if (action === "preview") return editDraftPreview(ctx, backendDb, draftId);
  if (action === "platforms") return editDraftPreview(ctx, backendDb, draftId, "platforms");
  if (action === "cycle_mode") {
    const nextMode = studioServices(backendDb, config).posts.cycleMode(actorId, draftId);
    await ctx.answerCallbackQuery({ text: `${ui(locale, "Mode", "Режим")}: ${modeLabel(nextMode, locale)}` });
    return editDraftPreview(ctx, backendDb, draftId);
  }
  if (action === "cancel_state") {
    clearPostAdminState(backendDb, Number(ctx.from?.id));
    await ctx.answerCallbackQuery();
    return editDraftPreview(ctx, backendDb, draftId);
  }
  if (["edit_ru", "edit_en", "replace_ru_media", "replace_en_media"].includes(action ?? "")) {
    if (!action) return;
    setPostAdminState(backendDb, Number(ctx.from?.id), action, draftId, callbackMessageId(ctx));
    await ctx.answerCallbackQuery({
      text: ui(locale, "Send the replacement in the next message", "Отправьте замену следующим сообщением"),
    });
    return editDraftPrompt(
      ctx,
      backendDb,
      draftId,
      action.startsWith("edit")
        ? ui(locale, "⌨ Send the new text in the next message.", "⌨ Отправьте новый текст следующим сообщением.")
        : ui(locale, "📎 Send the new photo or video in the next message.", "📎 Отправьте новое фото или видео следующим сообщением."),
    );
  }
  if (action === "cancel") {
    return editDraftPreview(ctx, backendDb, draftId, "confirm_delete");
  }
  if (action === "cancel_confirm") {
    studioServices(backendDb, config).posts.cancel(actorId, draftId);
    await ctx.answerCallbackQuery({ text: ui(locale, "Cancelled", "Отменено") });
    return void (await ctx.editMessageText(ui(locale, `🗑 Draft #${draftId} cancelled.`, `🗑 Черновик #${draftId} отменён.`)));
  }
  if (action === "publish") {
    return editDraftPreview(ctx, backendDb, draftId, "confirm_publish");
  }
  if (action === "publish_confirm") {
    studioServices(backendDb, config).posts.publishNow(actorId, draftId);
    await ctx.answerCallbackQuery({ text: ui(locale, "Queued", "В очереди") });
    const messageId = callbackMessageId(ctx);
    if (messageId && ctx.chat?.id) studioServices(backendDb, config).posts.setControlCard(actorId, draftId, Number(ctx.chat.id), messageId);
    const progress = renderPostProgress(studioServices(backendDb, config).posts.progress(actorId, draftId), locale);
    return void (await ctx.editMessageText(progress.text, { parse_mode: "Markdown", reply_markup: progress.keyboard }));
  }
  if (action === "schedule") {
    return editDraftPreview(ctx, backendDb, draftId, "schedule");
  }
  if (action === "sched_choose" && first) {
    const { ruAt, enAt } = studioServices(backendDb, config).posts.scheduleChoice(actorId, draftId, first);
    await ctx.answerCallbackQuery();
    return showScheduleConfirmation(ctx, backendDb, draftId, ruAt, enAt, `sched_confirm:${first}:${draftId}`);
  }
  if (action === "sched_confirm" && first) {
    const { ruAt, enAt } = studioServices(backendDb, config).posts.scheduleChoice(actorId, draftId, first);
    const postId = studioServices(backendDb, config).posts.schedule(actorId, draftId, { ruAt, enAt });
    await ctx.answerCallbackQuery({ text: ui(locale, "Scheduled", "Запланировано") });
    return void (await ctx.editMessageText(scheduledDraftText(locale, draftId, postId, ruAt, enAt)));
  }
  if (action === "sched_manual_confirm") {
    const state = getPostAdminState(backendDb, Number(ctx.from?.id));
    const match = state?.action?.match(/^schedule_confirm_(ru|en|both)_(.+)$/);
    if (!match || state?.draft_id !== draftId)
      return void (await ctx.answerCallbackQuery({
        text: ui(locale, "Schedule confirmation expired", "Подтверждение планирования устарело"),
      }));
    const scope = match[1];
    const iso = match[2];
    if (!scope || !iso)
      return void (await ctx.answerCallbackQuery({
        text: ui(locale, "Schedule confirmation expired", "Подтверждение планирования устарело"),
      }));
    const value = new Date(iso);
    if (Number.isNaN(value.getTime()))
      return void (await ctx.answerCallbackQuery({
        text: ui(locale, "Schedule confirmation expired", "Подтверждение планирования устарело"),
      }));
    const { ruAt, enAt } = studioServices(backendDb, config).posts.scheduleAt(actorId, draftId, scheduleScope(scope), value);
    const postId = studioServices(backendDb, config).posts.schedule(actorId, draftId, { ruAt, enAt });
    clearPostAdminState(backendDb, Number(ctx.from?.id));
    await ctx.answerCallbackQuery({ text: ui(locale, "Scheduled", "Запланировано") });
    return void (await ctx.editMessageText(scheduledDraftText(locale, draftId, postId, ruAt, enAt)));
  }
  if (action === "sched_auto") {
    const { ruAt, enAt } = studioServices(backendDb, config).posts.scheduleChoice(actorId, draftId, "auto");
    const postId = studioServices(backendDb, config).posts.schedule(actorId, draftId, { ruAt, enAt });
    await ctx.answerCallbackQuery({ text: ui(locale, "Scheduled", "Запланировано") });
    return void (await ctx.editMessageText(scheduledDraftText(locale, draftId, postId, ruAt, enAt)));
  }
  if (action === "sched_preset" && second && first) {
    const schedule = studioServices(backendDb, config).posts.scheduleChoice(actorId, draftId, first);
    const postId = studioServices(backendDb, config).posts.schedule(actorId, draftId, schedule);
    await ctx.answerCallbackQuery({ text: ui(locale, "Scheduled", "Запланировано") });
    return void (await ctx.editMessageText(scheduledDraftText(locale, draftId, postId, schedule.ruAt, schedule.enAt)));
  }
  if (action === "sched_manual" && first) {
    setPostAdminState(backendDb, Number(ctx.from?.id), `schedule_manual_${first}`, draftId, callbackMessageId(ctx));
    const locale = botLocale(backendDb, Number(ctx.from?.id));
    await ctx.answerCallbackQuery({ text: ui(locale, "Send time", "Введите время") });
    return editDraftPrompt(
      ctx,
      backendDb,
      draftId,
      ui(locale, "⌨ Send a date and time: `15.07 18:30` (MSK).", "⌨ Введите дату и время: `15.07 18:30` (МСК)."),
    );
  }
  await ctx.answerCallbackQuery({ text: ui(locale, "Unknown action", "Неизвестное действие") });
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
    const scope = action.slice("schedule_manual_".length);
    const { ruAt, enAt } = studioServices(backendDb, config).posts.manualSchedule(
      Number(ctx.from?.id),
      draftId,
      scheduleScope(scope),
      message.text,
    );
    const value = ruAt ?? enAt;
    if (!value) throw new Error("No publication time selected.");
    setPostAdminState(backendDb, Number(ctx.from?.id), `schedule_confirm_${scope}_${value.toISOString()}`, draftId, controlMessageId);
    if (controlMessageId && ctx.chat?.id)
      return showScheduleConfirmation(ctx, backendDb, draftId, ruAt, enAt, `sched_manual_confirm:${draftId}`, controlMessageId);
    return showScheduleConfirmation(ctx, backendDb, draftId, ruAt, enAt, `sched_manual_confirm:${draftId}`);
  } else if (action === "edit_ru" || action === "edit_en") {
    studioServices(backendDb, config).posts.editContent(Number(ctx.from?.id), draftId, {
      locale: action === "edit_ru" ? "ru" : "en",
      text: message.text,
      entities: message.entities,
      media: message.media,
    });
  } else if (action === "replace_ru_media" || action === "replace_en_media") {
    studioServices(backendDb, config).posts.editContent(Number(ctx.from?.id), draftId, {
      locale: action === "replace_ru_media" ? "ru" : "en",
      text: message.text,
      entities: message.entities,
      media: message.media,
      replaceMediaOnly: true,
    });
  }
  clearPostAdminState(backendDb, Number(ctx.from?.id));
  if (controlMessageId && ctx.chat?.id) {
    const preview = draftPreview(backendDb, draftId);
    await ctx.api.editMessageText(ctx.chat.id, controlMessageId, preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
  } else await sendDraftPreview(ctx, backendDb, draftId);
}

function scheduledDraftText(
  locale: ReturnType<typeof botLocale>,
  draftId: number,
  postId: number,
  ruAt: Date | null,
  enAt: Date | null,
): string {
  return `🟢 ${ui(locale, `Draft #${draftId} is scheduled as post #${postId}.`, `Черновик #${draftId} запланирован как пост #${postId}.`)}\n${ui(locale, "RU", "RU")}: ${formatMsk(ruAt)}\n${ui(locale, "EN", "EN")}: ${formatMsk(enAt)}`;
}

function callbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  return message && "message_id" in message ? message.message_id : null;
}

function scheduleScope(value: string): "ru" | "en" | "both" {
  if (value === "ru" || value === "en" || value === "both") return value;
  throw new Error("Unknown schedule scope.");
}
