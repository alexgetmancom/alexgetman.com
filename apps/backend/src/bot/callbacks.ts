import { eq } from "drizzle-orm";
import { type Context, InlineKeyboard } from "grammy";
import { PRESETS } from "../botTargets.js";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { adminState, drafts } from "../db/schema.js";
import { parseDeploymentRollbackCallback, requestDeploymentRollback } from "../deployment.js";
import { formatMsk, nextPublishingSlot, parseManualSchedule, rebalanceScheduledDrafts, schedulePreset } from "../publishing/schedule.js";
import { cancelDraft, hasLocaleTarget, publishDraftToQueue, requireDraft, setDraftControlCard } from "./drafts.js";
import { extractMessage, parseTargets } from "./message.js";
import { type DraftView, draftMode, draftPreview, modeLabel, toggleDraftTarget } from "./preview.js";
import { postProgress } from "./progress.js";

type AdminState = { action: string | null; draft_id: number | null; control_message_id: number | null };

export function getAdminState(backendDb: BackendDb, adminId: number): AdminState | null {
  return (
    backendDb.db
      .select({ action: adminState.action, draft_id: adminState.draftId, control_message_id: adminState.controlMessageId })
      .from(adminState)
      .where(eq(adminState.adminId, adminId))
      .get() ?? null
  );
}

function setAdminState(
  backendDb: BackendDb,
  adminId: number,
  action: string | null = null,
  draftId: number | null = null,
  controlMessageId: number | null = null,
): void {
  const updatedAt = new Date().toISOString();
  backendDb.db
    .insert(adminState)
    .values({ adminId, action, draftId, controlMessageId, updatedAt })
    .onConflictDoUpdate({ target: adminState.adminId, set: { action, draftId, controlMessageId, updatedAt } })
    .run();
}

export async function handleDraftCallback(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const deploymentRollback = parseDeploymentRollbackCallback(data);
  if (deploymentRollback) {
    const result = await requestDeploymentRollback(config, deploymentRollback.target, deploymentRollback.revision);
    await ctx.answerCallbackQuery({ text: "Rollback requested" });
    await ctx.reply(
      result.ok ? `Rollback complete: ${result.currentRevision.slice(0, 12)}.` : `Rollback was not performed: ${result.message}`,
    );
    return;
  }
  const parts = data.split(":");
  const [action, first, second] = parts;
  const draftId = Number(action === "preset" ? second : action?.startsWith("sched_") ? parts.at(-1) : first);
  if (!Number.isSafeInteger(draftId)) return void (await ctx.answerCallbackQuery({ text: "Bad draft id" }));
  if (action === "toggle" && second) {
    toggleDraftTarget(backendDb, draftId, second);
    await ctx.answerCallbackQuery({ text: `${second} toggled` });
    return editDraftPreview(ctx, backendDb, draftId, "platforms");
  }
  if (action === "preview") return editDraftPreview(ctx, backendDb, draftId);
  if (action === "platforms") return editDraftPreview(ctx, backendDb, draftId, "platforms");
  if (action === "cycle_mode") {
    const draft = requireDraft(backendDb, draftId);
    const targets = parseTargets(draft.targets_json);
    const mode = draftMode(targets);
    let nextMode: keyof typeof PRESETS = "full";
    if (mode === "full") nextMode = "ru";
    else if (mode === "ru") nextMode = "en";
    else if (mode === "en") nextMode = "tg";
    else nextMode = "full";

    backendDb.db
      .update(drafts)
      .set({ targetsJson: JSON.stringify(PRESETS[nextMode]), updatedAt: new Date().toISOString() })
      .where(eq(drafts.id, draftId))
      .run();
    await ctx.answerCallbackQuery({ text: `Mode: ${modeLabel(nextMode)}` });
    return editDraftPreview(ctx, backendDb, draftId);
  }
  if (action === "cancel_state") {
    clearAdminState(backendDb, Number(ctx.from?.id));
    await ctx.answerCallbackQuery();
    return editDraftPreview(ctx, backendDb, draftId);
  }
  if (["edit_ru", "edit_en", "replace_ru_media", "replace_en_media"].includes(action ?? "")) {
    if (!action) return;
    setAdminState(backendDb, Number(ctx.from?.id), action, draftId, callbackMessageId(ctx));
    await ctx.answerCallbackQuery({ text: "Send the replacement as the next message" });
    return editDraftPrompt(
      ctx,
      backendDb,
      draftId,
      action.startsWith("edit")
        ? "⌨ Отправьте новый текст следующим сообщением."
        : "📎 Отправьте новое фото или видео следующим сообщением.",
    );
  }
  if (action === "cancel") {
    return editDraftPreview(ctx, backendDb, draftId, "confirm_delete");
  }
  if (action === "cancel_confirm") {
    cancelDraft(backendDb, draftId);
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    return void (await ctx.editMessageText(`🗑 Черновик #${draftId} отменён.`));
  }
  if (action === "publish") {
    return editDraftPreview(ctx, backendDb, draftId, "confirm_publish");
  }
  if (action === "publish_confirm") {
    publishDraftToQueue(backendDb, draftId);
    await ctx.answerCallbackQuery({ text: "В очереди" });
    const messageId = callbackMessageId(ctx);
    if (messageId && ctx.chat?.id) setDraftControlCard(backendDb, draftId, Number(ctx.chat.id), messageId);
    const progress = postProgress(backendDb, draftId);
    return void (await ctx.editMessageText(progress.text, { parse_mode: "Markdown", reply_markup: progress.keyboard }));
  }
  if (action === "schedule") {
    return editDraftPreview(ctx, backendDb, draftId, "schedule");
  }
  if (action === "sched_choose" && first) {
    const targets = parseTargets(requireDraft(backendDb, draftId).targets_json);
    const value = first === "auto" ? null : schedulePreset(first);
    const ruAt = first === "auto" && hasLocaleTarget(targets, "ru") ? nextPublishingSlot(backendDb, "ru") : value;
    const enAt = first === "auto" && hasLocaleTarget(targets, "en") ? nextPublishingSlot(backendDb, "en") : value;
    const preview = draftPreview(backendDb, draftId);
    const keyboard = new InlineKeyboard()
      .text("✅ Confirm schedule", `sched_confirm:${first}:${draftId}`)
      .text("← Back", `schedule:${draftId}`);
    await ctx.answerCallbackQuery();
    return void (await ctx.editMessageText(`${preview.text}\n\n📅 *Confirm schedule*\nRU: ${formatMsk(ruAt)}\nEN: ${formatMsk(enAt)}`, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    }));
  }
  if (action === "sched_confirm" && first) {
    const targets = parseTargets(requireDraft(backendDb, draftId).targets_json);
    const value = first === "auto" ? null : schedulePreset(first);
    const ruAt = first === "auto" && hasLocaleTarget(targets, "ru") ? nextPublishingSlot(backendDb, "ru") : value;
    const enAt = first === "auto" && hasLocaleTarget(targets, "en") ? nextPublishingSlot(backendDb, "en") : value;
    const postId = publishDraftToQueue(backendDb, draftId, { mode: "scheduled", ruAt, enAt });
    rebalanceScheduledDrafts(backendDb);
    await ctx.answerCallbackQuery({ text: "Scheduled" });
    return void (await ctx.editMessageText(
      `🟢 Черновик #${draftId} запланирован как пост #${postId}.\nRU: ${formatMsk(ruAt)}\nEN: ${formatMsk(enAt)}`,
    ));
  }
  if (action === "sched_auto") {
    const targets = parseTargets(requireDraft(backendDb, draftId).targets_json);
    const ruAt = hasLocaleTarget(targets, "ru") ? nextPublishingSlot(backendDb, "ru") : null;
    const enAt = hasLocaleTarget(targets, "en") ? nextPublishingSlot(backendDb, "en") : null;
    const postId = publishDraftToQueue(backendDb, draftId, { mode: "scheduled", ruAt, enAt });
    rebalanceScheduledDrafts(backendDb);
    await ctx.answerCallbackQuery({ text: "Scheduled" });
    return void (await ctx.editMessageText(
      `🟢 Черновик #${draftId} запланирован как пост #${postId}.\nRU: ${formatMsk(ruAt)}\nEN: ${formatMsk(enAt)}`,
    ));
  }
  if (action === "sched_preset" && second && first) {
    const value = schedulePreset(first);
    const postId = publishDraftToQueue(backendDb, draftId, { mode: "scheduled", ruAt: value, enAt: value });
    rebalanceScheduledDrafts(backendDb);
    await ctx.answerCallbackQuery({ text: "Scheduled" });
    return void (await ctx.editMessageText(`🟢 Черновик #${draftId} запланирован как пост #${postId}.\nRU/EN: ${formatMsk(value)}`));
  }
  if (action === "sched_manual" && first) {
    setAdminState(backendDb, Number(ctx.from?.id), `schedule_manual_${first}`, draftId, callbackMessageId(ctx));
    await ctx.answerCallbackQuery({ text: "Send time" });
    return editDraftPrompt(ctx, backendDb, draftId, "⌨ Введите дату и время: `15.07 18:30` (МСК).");
  }
  await ctx.answerCallbackQuery({ text: "Unknown action" });
}

export async function applyAdminState(
  ctx: Context,
  backendDb: BackendDb,
  action: string,
  draftId: number,
  controlMessageId: number | null,
): Promise<void> {
  const message = extractMessage(ctx);
  const now = new Date().toISOString();
  if (action.startsWith("schedule_manual_")) {
    const value = parseManualSchedule(message.text);
    const scope = action.slice("schedule_manual_".length);
    const draft = requireDraft(backendDb, draftId);
    const ruAt = scope === "en" ? dateOrNull(draft.scheduled_at) : value;
    const enAt = scope === "ru" ? dateOrNull(draft.scheduled_en_at) : value;
    publishDraftToQueue(backendDb, draftId, { mode: "scheduled", ruAt, enAt });
    rebalanceScheduledDrafts(backendDb);
  } else if (action === "edit_ru" || action === "edit_en") {
    const isRu = action === "edit_ru";
    const updatePayload: any = { updatedAt: now };
    const cleanText = message.text?.trim().toLowerCase();
    const shouldClearMedia =
      cleanText === "/delmedia" || cleanText === "очистить" || cleanText === "без медиа" || cleanText === "clear media";

    if (shouldClearMedia) {
      if (isRu) {
        updatePayload.mediaRuJson = null;
      } else {
        updatePayload.mediaEnJson = null;
      }
    } else {
      if (message.media.length > 0) {
        if (isRu) {
          updatePayload.mediaRuJson = JSON.stringify(message.media);
        } else {
          updatePayload.mediaEnJson = JSON.stringify(message.media);
        }
      }
      if (message.text) {
        if (isRu) {
          updatePayload.textRu = message.text;
          updatePayload.textRuEntitiesJson = JSON.stringify(message.entities);
        } else {
          updatePayload.textEnApproved = message.text;
          updatePayload.textEnEntitiesJson = JSON.stringify(message.entities);
        }
      }
    }
    if (Object.keys(updatePayload).length <= 1) {
      throw new Error("No text or media detected for editing.");
    }
    backendDb.db.update(drafts).set(updatePayload).where(eq(drafts.id, draftId)).run();
  } else if (action === "replace_ru_media" || action === "replace_en_media") {
    if (message.media.length === 0) throw new Error("replacement media is empty");
    backendDb.db
      .update(drafts)
      .set(
        action === "replace_ru_media"
          ? { mediaRuJson: JSON.stringify(message.media), updatedAt: now }
          : { mediaEnJson: JSON.stringify(message.media), updatedAt: now },
      )
      .where(eq(drafts.id, draftId))
      .run();
  }
  setAdminState(backendDb, Number(ctx.from?.id));
  if (controlMessageId && ctx.chat?.id) {
    const preview = draftPreview(backendDb, draftId);
    await ctx.api.editMessageText(ctx.chat.id, controlMessageId, preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
  } else await sendDraftPreview(ctx, backendDb, draftId);
}

export async function sendDraftPreview(ctx: Pick<Context, "reply">, backendDb: BackendDb, draftId: number) {
  const preview = draftPreview(backendDb, draftId);
  return ctx.reply(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
}

async function editDraftPreview(ctx: Context, backendDb: BackendDb, draftId: number, view: DraftView = "overview"): Promise<void> {
  const preview = draftPreview(backendDb, draftId, view);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
}

async function editDraftPrompt(ctx: Context, backendDb: BackendDb, draftId: number, prompt: string): Promise<void> {
  const preview = draftPreview(backendDb, draftId);
  const keyboard = new InlineKeyboard().text("← Cancel", `cancel_state:${draftId}`);
  await ctx.editMessageText(`${preview.text}\n\n${prompt}`, { parse_mode: "Markdown", reply_markup: keyboard });
}

export function clearAdminState(backendDb: BackendDb, adminId: number): void {
  setAdminState(backendDb, adminId);
}

export function startPostDialog(backendDb: BackendDb, adminId: number): void {
  setAdminState(backendDb, adminId, "new_post");
}

function dateOrNull(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function callbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  return message && "message_id" in message ? message.message_id : null;
}
