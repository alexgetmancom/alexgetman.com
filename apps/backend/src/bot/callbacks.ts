import { eq } from "drizzle-orm";
import type { Context } from "grammy";
import { PRESETS } from "../botTargets.js";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { adminState, drafts } from "../db/schema.js";
import { isDeploymentRollbackCallback, requestDeploymentRollback } from "../deployment.js";
import { formatMsk, nextPublishingSlot, parseManualSchedule, rebalanceScheduledDrafts, schedulePreset } from "../publishingSchedule.js";
import { cancelDraft, hasLocaleTarget, publishDraftToQueue, requireDraft } from "./drafts.js";
import { extractMessage, parseTargets } from "./message.js";
import { draftPreview, toggleDraftTarget } from "./preview.js";

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
  if (isDeploymentRollbackCallback(data)) {
    const result = await requestDeploymentRollback(config, data.slice("deploy_rollback:".length));
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
    return editDraftPreview(ctx, backendDb, draftId);
  }
  if (action === "preview") return editDraftPreview(ctx, backendDb, draftId);
  if (action === "mode") return editDraftPreview(ctx, backendDb, draftId, "modes");
  if (action === "preset" && first && PRESETS[first]) {
    backendDb.db
      .update(drafts)
      .set({ targetsJson: JSON.stringify(PRESETS[first]), updatedAt: new Date().toISOString() })
      .where(eq(drafts.id, draftId))
      .run();
    return editDraftPreview(ctx, backendDb, draftId, "modes");
  }
  if (action === "preset" && first === "manual") {
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
    cancelDraft(backendDb, draftId);
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    return void (await ctx.editMessageText(`🗑 Черновик #${draftId} отменён.`));
  }
  if (action === "publish") {
    return editDraftPreview(ctx, backendDb, draftId, "confirm_publish");
  }
  if (action === "publish_confirm") {
    const postId = publishDraftToQueue(backendDb, draftId);
    await ctx.answerCallbackQuery({ text: "В очереди" });
    return void (await ctx.editMessageText(`🟢 Публикация #${draftId} поставлена в очередь как пост #${postId}.`));
  }
  if (action === "schedule") {
    return editDraftPreview(ctx, backendDb, draftId, "schedule");
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
    if (!message.text) throw new Error("edited text is empty");
    const values =
      action === "edit_ru"
        ? { textRu: message.text, textRuEntitiesJson: JSON.stringify(message.entities), updatedAt: now }
        : { textEnApproved: message.text, textEnEntitiesJson: JSON.stringify(message.entities), updatedAt: now };
    backendDb.db.update(drafts).set(values).where(eq(drafts.id, draftId)).run();
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

export async function sendDraftPreview(ctx: Pick<Context, "reply">, backendDb: BackendDb, draftId: number): Promise<void> {
  const preview = draftPreview(backendDb, draftId);
  await ctx.reply(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
}

async function editDraftPreview(
  ctx: Context,
  backendDb: BackendDb,
  draftId: number,
  view: "overview" | "modes" | "schedule" | "confirm_publish" = "overview",
): Promise<void> {
  const preview = draftPreview(backendDb, draftId, view);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
}

async function editDraftPrompt(ctx: Context, backendDb: BackendDb, draftId: number, prompt: string): Promise<void> {
  const preview = draftPreview(backendDb, draftId);
  await ctx.editMessageText(`${preview.text}\n\n${prompt}`, { parse_mode: "Markdown", reply_markup: preview.keyboard });
}

export function clearAdminState(backendDb: BackendDb, adminId: number): void {
  setAdminState(backendDb, adminId);
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
