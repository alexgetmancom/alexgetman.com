import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import { withActionLock } from "../foundation/action-lock.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { setTelegramPostProgressCard } from "../interfaces/telegram/control-cards.js";
import { sendTelegramDeliveryPreviews } from "../interfaces/telegram/delivery-previews.js";
import { t } from "../interfaces/telegram/i18n/index.js";
import { formatMsk } from "../interfaces/telegram/time.js";
import { studioServices } from "../studio/services/index.js";
import { botLocale } from "./i18n.js";
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
  if (!Number.isSafeInteger(draftId)) return void (await ctx.answerCallbackQuery({ text: t(locale, "action.invalid-post") }));
  studioServices(backendDb, config).posts.get(actorId, draftId);
  if (action === "toggle" && second) {
    studioServices(backendDb, config).posts.toggleTarget(actorId, draftId, second);
    await ctx.answerCallbackQuery({ text: t(locale, "action.target-updated", { target: second }) });
    return editDraftPreview(ctx, backendDb, draftId, "platforms");
  }
  if (action === "preview") return editDraftPreview(ctx, backendDb, draftId);
  if (action === "platforms") return editDraftPreview(ctx, backendDb, draftId, "platforms");
  if (action === "cycle_mode") {
    const nextMode = studioServices(backendDb, config).posts.cycleMode(actorId, draftId);
    await ctx.answerCallbackQuery({ text: `${t(locale, "post.mode")}: ${modeLabel(nextMode, locale)}` });
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
      text: t(locale, "action.send-replacement"),
    });
    return editDraftPrompt(
      ctx,
      backendDb,
      draftId,
      action.startsWith("edit") ? t(locale, "action.send-new-text") : t(locale, "action.send-new-media"),
    );
  }
  if (action === "cancel") {
    return editDraftPreview(ctx, backendDb, draftId, "confirm_delete");
  }
  if (action === "cancel_confirm") {
    const result = await withActionLock(`${actorId}:${data}`, async () => {
      studioServices(backendDb, config).posts.cancel(actorId, draftId);
    });
    if (!result.ok) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery({ text: t(locale, "action.cancelled") });
    return void (await ctx.editMessageText(t(locale, "action.draft-cancelled", { id: draftId })));
  }
  if (action === "publish") {
    if (await showPublicationPreflight(ctx, backendDb, config, actorId, draftId, locale)) return;
    const delivery = studioServices(backendDb, config).posts.preview(actorId, draftId).delivery;
    await sendTelegramDeliveryPreviews(ctx, delivery.projections, botLocale(backendDb, actorId));
    const preview = draftPreview(backendDb, draftId, "confirm_publish");
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
    return editDraftPreview(ctx, backendDb, draftId, "schedule");
  }
  if (action === "sched_choose" && first) {
    const { ruAt, enAt } = studioServices(backendDb, config).posts.scheduleChoice(actorId, draftId, first);
    await ctx.answerCallbackQuery();
    await sendPostPreviews(ctx, backendDb, config, actorId, draftId);
    return showScheduleConfirmation(ctx, backendDb, draftId, ruAt, enAt, `sched_confirm:${first}:${draftId}`);
  }
  if (action === "sched_confirm" && first) {
    const result = await withActionLock(`${actorId}:${data}`, async () => {
      const { ruAt, enAt } = studioServices(backendDb, config).posts.scheduleChoice(actorId, draftId, first);
      return { postId: studioServices(backendDb, config).posts.schedule(actorId, draftId, { ruAt, enAt }), ruAt, enAt };
    });
    if (!result.ok) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery({ text: t(locale, "common.scheduled") });
    return void (await ctx.editMessageText(scheduledDraftText(locale, draftId, result.value.postId, result.value.ruAt, result.value.enAt)));
  }
  if (action === "sched_manual_confirm") {
    const state = getPostAdminState(backendDb, Number(ctx.from?.id));
    const match = state?.action?.match(/^schedule_confirm_(ru|en|both)_(.+)$/);
    if (!match || state?.draft_id !== draftId)
      return void (await ctx.answerCallbackQuery({
        text: t(locale, "action.schedule-expired"),
      }));
    const scope = match[1];
    const iso = match[2];
    if (!scope || !iso)
      return void (await ctx.answerCallbackQuery({
        text: t(locale, "action.schedule-expired"),
      }));
    const value = new Date(iso);
    if (Number.isNaN(value.getTime()))
      return void (await ctx.answerCallbackQuery({
        text: t(locale, "action.schedule-expired"),
      }));
    const result = await withActionLock(`${actorId}:sched_manual_confirm:${draftId}`, async () => {
      const { ruAt, enAt } = studioServices(backendDb, config).posts.scheduleAt(actorId, draftId, scheduleScope(scope), value);
      return { postId: studioServices(backendDb, config).posts.schedule(actorId, draftId, { ruAt, enAt }), ruAt, enAt };
    });
    if (!result.ok) return void (await ctx.answerCallbackQuery());
    clearPostAdminState(backendDb, Number(ctx.from?.id));
    await ctx.answerCallbackQuery({ text: t(locale, "common.scheduled") });
    return void (await ctx.editMessageText(scheduledDraftText(locale, draftId, result.value.postId, result.value.ruAt, result.value.enAt)));
  }
  if (action === "sched_auto") {
    const result = await withActionLock(`${actorId}:${data}`, async () => {
      const { ruAt, enAt } = studioServices(backendDb, config).posts.scheduleChoice(actorId, draftId, "auto");
      return { postId: studioServices(backendDb, config).posts.schedule(actorId, draftId, { ruAt, enAt }), ruAt, enAt };
    });
    if (!result.ok) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery({ text: t(locale, "common.scheduled") });
    return void (await ctx.editMessageText(scheduledDraftText(locale, draftId, result.value.postId, result.value.ruAt, result.value.enAt)));
  }
  if (action === "sched_preset" && second && first) {
    const result = await withActionLock(`${actorId}:${data}`, async () => {
      const schedule = studioServices(backendDb, config).posts.scheduleChoice(actorId, draftId, first);
      return { postId: studioServices(backendDb, config).posts.schedule(actorId, draftId, schedule), schedule };
    });
    if (!result.ok) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery({ text: t(locale, "common.scheduled") });
    return void (await ctx.editMessageText(
      scheduledDraftText(locale, draftId, result.value.postId, result.value.schedule.ruAt, result.value.schedule.enAt),
    ));
  }
  if (action === "sched_manual" && first) {
    setPostAdminState(backendDb, Number(ctx.from?.id), `schedule_manual_${first}`, draftId, callbackMessageId(ctx));
    const locale = botLocale(backendDb, Number(ctx.from?.id));
    await ctx.answerCallbackQuery({ text: t(locale, "action.send-time") });
    return editDraftPrompt(ctx, backendDb, draftId, t(locale, "action.enter-datetime"));
  }
  await ctx.answerCallbackQuery({ text: t(locale, "action.unknown") });
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
    text: t(locale, "action.preflight", { message: issue.message, actual: issue.actual, limit: issue.limit }),
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
    const scope = action.slice("schedule_manual_".length);
    const { ruAt, enAt } = studioServices(backendDb, config).posts.manualSchedule(
      Number(ctx.from?.id),
      draftId,
      scheduleScope(scope),
      message.text,
    );
    const value = ruAt ?? enAt;
    if (!value) throw new StudioError("err.no-pub-time");
    setPostAdminState(backendDb, Number(ctx.from?.id), `schedule_confirm_${scope}_${value.toISOString()}`, draftId, controlMessageId);
    await sendPostPreviews(ctx, backendDb, config, Number(ctx.from?.id), draftId);
    return showScheduleConfirmation(ctx, backendDb, draftId, ruAt, enAt, `sched_manual_confirm:${draftId}`);
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
  }
  clearPostAdminState(backendDb, Number(ctx.from?.id));
  if (controlMessageId && ctx.chat?.id) {
    const preview = draftPreview(backendDb, draftId);
    await ctx.api.editMessageText(ctx.chat.id, controlMessageId, preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
  } else await sendDraftPreview(ctx, backendDb, draftId);
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
): string {
  return `🟢 ${t(locale, "action.scheduled-as", { draftId, postId })}\nRU: ${formatMsk(ruAt)}\nEN: ${formatMsk(enAt)}`;
}

function callbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  return message && "message_id" in message ? message.message_id : null;
}

function scheduleScope(value: string): "ru" | "en" | "both" {
  if (value === "ru" || value === "en" || value === "both") return value;
  throw new StudioError("err.unknown-scope");
}
