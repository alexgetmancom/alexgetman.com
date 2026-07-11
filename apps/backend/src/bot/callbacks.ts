import { eq } from "drizzle-orm";
import { type Context, InlineKeyboard } from "grammy";
import { PRESETS } from "../botTargets.js";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { adminState, drafts } from "../db/schema.js";
import { isDeploymentRollbackCallback, requestDeploymentRollback } from "../deployment.js";
import { generateStoryMedia } from "../media/story.js";
import { formatMsk, nextPublishingSlot, parseManualSchedule, rebalanceScheduledDrafts, schedulePreset } from "../publishingSchedule.js";
import { cancelDraft, hasLocaleTarget, publishDraftToQueue, requireDraft } from "./drafts.js";
import { extractMessage, parseJson, parseTargets } from "./message.js";
import { draftPreview, toggleDraftTarget } from "./preview.js";

type AdminState = { action: string | null; draft_id: number | null };

export function getAdminState(backendDb: BackendDb, adminId: number): AdminState | null {
  return (
    backendDb.db
      .select({ action: adminState.action, draft_id: adminState.draftId })
      .from(adminState)
      .where(eq(adminState.adminId, adminId))
      .get() ?? null
  );
}

function setAdminState(backendDb: BackendDb, adminId: number, action: string | null = null, draftId: number | null = null): void {
  const updatedAt = new Date().toISOString();
  backendDb.db
    .insert(adminState)
    .values({ adminId, action, draftId, updatedAt })
    .onConflictDoUpdate({ target: adminState.adminId, set: { action, draftId, updatedAt } })
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
    await ctx.answerCallbackQuery({ text: `${second} toggled` });
    return sendDraftPreview(ctx, backendDb, draftId);
  }
  if (action === "preset" && first && PRESETS[first]) {
    backendDb.db
      .update(drafts)
      .set({ targetsJson: JSON.stringify(PRESETS[first]), updatedAt: new Date().toISOString() })
      .where(eq(drafts.id, draftId))
      .run();
    await ctx.answerCallbackQuery({ text: `${first} preset` });
    return sendDraftPreview(ctx, backendDb, draftId);
  }
  if (["edit_ru", "edit_en", "replace_ru_media", "replace_en_media"].includes(action ?? "")) {
    if (!action) return;
    setAdminState(backendDb, Number(ctx.from?.id), action, draftId);
    await ctx.answerCallbackQuery({ text: "Send the replacement as the next message" });
    return void (await ctx.reply(
      action.startsWith("edit") ? "Send edited text as the next message." : "Send replacement photo/video as the next message.",
    ));
  }
  if (action === "use_ru_media") {
    backendDb.db.update(drafts).set({ mediaEnJson: null, updatedAt: new Date().toISOString() }).where(eq(drafts.id, draftId)).run();
    await ctx.answerCallbackQuery({ text: "EN media uses RU fallback" });
    return sendDraftPreview(ctx, backendDb, draftId);
  }
  if (action === "generate_story_ru" || action === "generate_story_en") {
    const locale = action.endsWith("_ru") ? "ru" : "en";
    const draft = requireDraft(backendDb, draftId);
    const source = locale === "en" ? (parseJson(draft.media_en_json) ?? parseJson(draft.media_ru_json)) : parseJson(draft.media_ru_json);
    const generated = await generateStoryMedia(source, draftId, locale, config);
    backendDb.db
      .update(drafts)
      .set(
        locale === "en"
          ? { mediaEnJson: JSON.stringify(generated), updatedAt: new Date().toISOString() }
          : { mediaRuJson: JSON.stringify(generated), updatedAt: new Date().toISOString() },
      )
      .where(eq(drafts.id, draftId))
      .run();
    await ctx.answerCallbackQuery({ text: `${locale.toUpperCase()} 9:16 generated` });
    return sendDraftPreview(ctx, backendDb, draftId);
  }
  if (action === "cancel") {
    cancelDraft(backendDb, draftId);
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    return void (await ctx.reply(`Draft #${draftId} cancelled.`));
  }
  if (action === "publish") {
    const postId = publishDraftToQueue(backendDb, draftId);
    await ctx.answerCallbackQuery({ text: "Queued" });
    return void (await ctx.reply(`Draft #${draftId} queued as post #${postId}`));
  }
  if (action === "schedule") {
    const keyboard = new InlineKeyboard()
      .text("Auto next slots", `sched_auto:${draftId}`)
      .text("+30 min", `sched_preset:plus30:${draftId}`)
      .row()
      .text("+1 hour", `sched_preset:plus60:${draftId}`)
      .text("Today 21:00", `sched_preset:today2100:${draftId}`)
      .row()
      .text("Tomorrow 10:00", `sched_preset:tomorrow1000:${draftId}`)
      .row()
      .text("Manual both", `sched_manual:both:${draftId}`)
      .text("Manual RU", `sched_manual:ru:${draftId}`)
      .text("Manual EN", `sched_manual:en:${draftId}`);
    await ctx.answerCallbackQuery();
    return void (await ctx.reply(`Choose schedule time for draft #${draftId}.`, { reply_markup: keyboard }));
  }
  if (action === "sched_auto") {
    const targets = parseTargets(requireDraft(backendDb, draftId).targets_json);
    const ruAt = hasLocaleTarget(targets, "ru") ? nextPublishingSlot(backendDb, "ru") : null;
    const enAt = hasLocaleTarget(targets, "en") ? nextPublishingSlot(backendDb, "en") : null;
    const postId = publishDraftToQueue(backendDb, draftId, { mode: "scheduled", ruAt, enAt });
    rebalanceScheduledDrafts(backendDb);
    await ctx.answerCallbackQuery({ text: "Scheduled" });
    await ctx.reply(`Draft #${draftId} scheduled as post #${postId}.\nRU: ${formatMsk(ruAt)}\nEN: ${formatMsk(enAt)}`);
    return sendDraftPreview(ctx, backendDb, draftId);
  }
  if (action === "sched_preset" && second && first) {
    const value = schedulePreset(first);
    const postId = publishDraftToQueue(backendDb, draftId, { mode: "scheduled", ruAt: value, enAt: value });
    rebalanceScheduledDrafts(backendDb);
    await ctx.answerCallbackQuery({ text: "Scheduled" });
    return void (await ctx.reply(`Draft #${draftId} scheduled as post #${postId}.\nRU/EN: ${formatMsk(value)}`));
  }
  if (action === "sched_manual" && first) {
    setAdminState(backendDb, Number(ctx.from?.id), `schedule_manual_${first}`, draftId);
    await ctx.answerCallbackQuery({ text: "Send time" });
    return void (await ctx.reply("Send time as HH:MM or DD.MM HH:MM."));
  }
  await ctx.answerCallbackQuery({ text: "Unknown action" });
}

export async function applyAdminState(ctx: Context, backendDb: BackendDb, action: string, draftId: number): Promise<void> {
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
  await ctx.reply(`Draft #${draftId} updated.`);
  await sendDraftPreview(ctx, backendDb, draftId);
}

export async function sendDraftPreview(ctx: Pick<Context, "reply">, backendDb: BackendDb, draftId: number): Promise<void> {
  const preview = draftPreview(backendDb, draftId);
  await ctx.reply(preview.text, { reply_markup: preview.keyboard });
}

export function clearAdminState(backendDb: BackendDb, adminId: number): void {
  setAdminState(backendDb, adminId);
}

function dateOrNull(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
