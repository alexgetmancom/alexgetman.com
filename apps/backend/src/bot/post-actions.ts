import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import { withActionLock } from "../foundation/action-lock.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { setTelegramPostProgressCard } from "../interfaces/telegram/control-cards.js";
import { sendTelegramDeliveryPreviews } from "../interfaces/telegram/delivery-previews.js";
import { suggestDraftEntities } from "../interfaces/telegram/draft-enrichment.js";
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
    return editDraftPreview(ctx, backendDb, draftId, config);
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
  if (action === "entities_accept") {
    studioServices(backendDb, config).posts.acceptEntityCandidates(actorId, draftId);
    await ctx.answerCallbackQuery({ text: locale === "ru" ? "Сущности приняты" : "Entities accepted" });
    return editDraftPreview(ctx, backendDb, draftId, config);
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
    return void (await ctx.editMessageText(t(locale, "action.draft-cancelled", { id: draftId })));
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
  if (action === "sched_choose" && first) {
    const { ruAt, enAt } = studioServices(backendDb, config).posts.scheduleChoice(actorId, draftId, first);
    await ctx.answerCallbackQuery();
    await sendPostPreviews(ctx, backendDb, config, actorId, draftId);
    return showScheduleConfirmation(ctx, backendDb, draftId, config, ruAt, enAt, `sched_confirm:${first}:${draftId}`);
  }
  if (action === "sched_confirm" && first) return confirmScheduleChoice(ctx, backendDb, config, actorId, draftId, first, locale, data);
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
    return void (await ctx.editMessageText(
      scheduledDraftText(locale, draftId, result.value.postId, result.value.ruAt, result.value.enAt, config),
    ));
  }
  if (action === "sched_auto") return confirmScheduleChoice(ctx, backendDb, config, actorId, draftId, "auto", locale, data);
  if (action === "sched_preset" && second && first)
    return confirmScheduleChoice(ctx, backendDb, config, actorId, draftId, first, locale, data);
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
    text: t(locale, "action.preflight", { label: issue.label, actual: issue.actual, limit: issue.limit }),
    show_alert: true,
  });
  return true;
}

/** Shared by every "schedule with a preset choice" callback: sched_confirm, sched_auto, sched_preset. */
async function confirmScheduleChoice(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  choice: string,
  locale: ReturnType<typeof botLocale>,
  lockKey: string,
): Promise<void> {
  const result = await withActionLock(`${actorId}:${lockKey}`, async () => {
    const { ruAt, enAt } = studioServices(backendDb, config).posts.scheduleChoice(actorId, draftId, choice);
    return { postId: studioServices(backendDb, config).posts.schedule(actorId, draftId, { ruAt, enAt }), ruAt, enAt };
  });
  if (!result.ok) return void (await ctx.answerCallbackQuery());
  await ctx.answerCallbackQuery({ text: t(locale, "common.scheduled") });
  await ctx.editMessageText(scheduledDraftText(locale, draftId, result.value.postId, result.value.ruAt, result.value.enAt, config));
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
    return showScheduleConfirmation(ctx, backendDb, draftId, config, ruAt, enAt, `sched_manual_confirm:${draftId}`);
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
    const draft = studioServices(backendDb, config).posts.get(Number(ctx.from?.id), draftId);
    try {
      const candidates = await suggestDraftEntities(config, String(draft.text_ru || draft.text_en_approved || ""), urls);
      if (candidates.length) {
        studioServices(backendDb, config).posts.replaceEntityCandidates(Number(ctx.from?.id), draftId, candidates);
        const labels: Record<string, string> = { company: "Компания", model: "Модель", person: "Человек", topic: "Тема" };
        await ctx.reply(
          `ИИ предлагает сущности:\n${candidates.map((entity) => `• ${labels[entity.kind]}: ${entity.titleRu}`).join("\n")}`,
          {
            reply_markup: new InlineKeyboard().text("✓ Принять", `entities_accept:${draftId}`),
          },
        );
      }
    } catch {}
  }
  clearPostAdminState(backendDb, Number(ctx.from?.id));
  if (controlMessageId && ctx.chat?.id) {
    const preview = draftPreview(backendDb, draftId, config);
    await ctx.api.editMessageText(ctx.chat.id, controlMessageId, preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
  } else await sendDraftPreview(ctx, backendDb, draftId, config);
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

function scheduleScope(value: string): "ru" | "en" | "both" {
  if (value === "ru" || value === "en" || value === "both") return value;
  throw new StudioError("err.unknown-scope");
}
