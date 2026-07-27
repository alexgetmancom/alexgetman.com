import { eq } from "drizzle-orm";
import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import { videoBotSessions } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import { setTelegramVideoCard } from "../interfaces/telegram/control-cards.js";
import { VIDEO_TARGETS, type VideoTarget, videoTargetLabel } from "../publishing/video-types.js";
import { nextVideoFlowStep, previousVideoMetadataStep, type VideoPrompt, type VideoWizardStep } from "../studio/video-fsm.js";
import { type BotLocale, botLocale } from "./i18n.js";

export type VideoSession = { draftId: number | null; step: string; selected: VideoTarget[]; data: Record<string, unknown> };

export function targetKeyboard(config: BackendConfig, selected: VideoTarget[], locale: BotLocale): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const target of enabledVideoTargets(config)) {
    keyboard.text(`${selected.includes(target) ? "✓" : "○"} ${videoTargetLabel(target)}`, `video_toggle:${target}`).row();
  }
  return keyboard.text(t(locale, "video.next"), "video_targets_done").row().text(t(locale, "common.cancel"), "video_cancel_dialog");
}

export function enabledVideoTargets(config: BackendConfig): VideoTarget[] {
  return VIDEO_TARGETS.filter(
    (target) =>
      (target !== "youtube_shorts" || config.studio.modules.youtube) && (target !== "instagram_reels" || config.studio.modules.instagram),
  );
}

export function getSession(backendDb: BackendDb, actorId: number): VideoSession | null {
  const row = backendDb.db.select().from(videoBotSessions).where(eq(videoBotSessions.actorId, actorId)).get();
  return row
    ? { draftId: row.videoDraftId, step: row.step, selected: row.selectedTargetsJson as VideoTarget[], data: row.dataJson ?? {} }
    : null;
}

export function saveSession(backendDb: BackendDb, actorId: number, session: VideoSession): void {
  const now = new Date().toISOString();
  backendDb.db
    .insert(videoBotSessions)
    .values({
      actorId,
      videoDraftId: session.draftId,
      step: session.step,
      selectedTargetsJson: session.selected,
      dataJson: session.data,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: videoBotSessions.actorId,
      set: {
        videoDraftId: session.draftId,
        step: session.step,
        selectedTargetsJson: session.selected,
        dataJson: session.data,
        updatedAt: now,
      },
    })
    .run();
}

export function setData(
  backendDb: BackendDb,
  actorId: number,
  session: VideoSession,
  key: string,
  value: unknown,
  nextStep: string,
): VideoSession {
  const next = { ...session, step: nextStep, data: { ...session.data, [key]: value } };
  saveSession(backendDb, actorId, next);
  return next;
}

export function clearSession(backendDb: BackendDb, actorId: number): void {
  backendDb.db.delete(videoBotSessions).where(eq(videoBotSessions.actorId, actorId)).run();
}

export async function updateVideoControl(
  ctx: Context,
  session: VideoSession,
  text: string,
  keyboard: InlineKeyboard | undefined,
  locale: BotLocale,
): Promise<void> {
  const messageId = Number(session.data.controlMessageId);
  const replyMarkup = keyboard ?? new InlineKeyboard().text(t(locale, "common.cancel"), "video_cancel_dialog");
  if (messageId && ctx.chat?.id)
    return void (await ctx.api.editMessageText(ctx.chat.id, messageId, text, { parse_mode: "Markdown", reply_markup: replyMarkup }));
  await ctx.reply(text, { parse_mode: "Markdown", reply_markup: replyMarkup });
}

/** Sends the next question as a normal chat message, without moving an earlier
 * control card. Always offers Cancel so a free-text prompt is never a dead end.
 * Pass `plainText` for anything carrying an error message: those embed raw
 * paths and API responses whose `_` and `*` make Telegram reject the whole
 * send as unparsable Markdown, losing exactly the text worth reading. */
export async function replyVideoPrompt(ctx: Context, locale: BotLocale, text: string, options?: { plainText?: boolean }): Promise<void> {
  await ctx.reply(text, {
    ...(options?.plainText ? {} : { parse_mode: "Markdown" }),
    reply_markup: new InlineKeyboard().text(t(locale, "common.cancel"), "video_cancel_dialog"),
  });
}

/** Every metadata-step prompt goes through here so "← Back" (and, for the
 * game URL, "Skip") and Cancel are always offered consistently, whether
 * reached moving forward through the wizard or by tapping Back from a later step. */
export async function sendVideoMetadataPrompt(
  ctx: Context,
  backendDb: BackendDb,
  actorId: number,
  step: VideoWizardStep,
  selected: VideoTarget[],
): Promise<void> {
  const locale = botLocale(backendDb, actorId);
  const keyboard = new InlineKeyboard();
  if (step === "youtube_game_url") keyboard.text(t(locale, "video.skip"), "video_game_skip");
  if (previousVideoMetadataStep(step, selected)) keyboard.text(t(locale, "common.back"), "video_meta_back");
  keyboard.text(t(locale, "common.cancel"), "video_cancel_dialog");
  await ctx.reply(videoPrompt(locale, step), { reply_markup: keyboard });
}

function videoPrompt(locale: BotLocale, prompt: VideoPrompt): string {
  if (prompt === "youtube_title") return t(locale, "video.prompt-yt-title");
  if (prompt === "youtube_description") return t(locale, "video.prompt-yt-description");
  if (prompt === "youtube_game_url") return t(locale, "video.prompt-yt-game-url");
  if (prompt === "youtube_tags") return t(locale, "video.prompt-yt-tags");
  if (prompt === "instagram_caption") return t(locale, "video.prompt-ig-caption");
  return t(locale, "video.prompt-when-publish");
}

/**
 * Sends a temporary interactive card and remembers only that card for checkbox/schedule edits.
 * Regular questions deliberately use replyVideoPrompt so the conversation stays at the bottom.
 */
export async function sendVideoControl(
  ctx: Context,
  backendDb: BackendDb,
  actorId: number,
  session: VideoSession,
  text: string,
  keyboard: InlineKeyboard,
): Promise<VideoSession> {
  const message = await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
  const next = { ...session, data: { ...session.data, controlMessageId: message.message_id } };
  saveSession(backendDb, actorId, next);
  return next;
}

export async function askInstagramOrSchedule(ctx: Context, backendDb: BackendDb, actorId: number, session: VideoSession): Promise<void> {
  if (nextVideoFlowStep(session.selected) === "instagram_caption") {
    const next = { ...session, step: "instagram_caption" };
    saveSession(backendDb, actorId, next);
    await sendVideoMetadataPrompt(ctx, backendDb, actorId, "instagram_caption", session.selected);
    return;
  }
  await askSchedule(ctx, backendDb, actorId, session);
}

// A curated spread across the same posting hours as text-post scheduling
// (morning through evening); video has no per-locale slot grid, so this is
// one flat preset list rather than RU/EN-specific ones.
const VIDEO_SLOT_PRESETS = ["08:00", "11:00", "13:00", "18:00", "20:00", "22:00"];

/** Prompts for a schedule time with slot-button presets plus a manual-entry
 * fallback, replacing a bare free-text-only prompt. */
export async function sendVideoTimePrompt(
  ctx: Context,
  backendDb: BackendDb,
  actorId: number,
  session: VideoSession,
  text: string,
): Promise<VideoSession> {
  const locale = botLocale(backendDb, actorId);
  const keyboard = new InlineKeyboard();
  for (let index = 0; index < VIDEO_SLOT_PRESETS.length; index += 2) {
    for (const clock of VIDEO_SLOT_PRESETS.slice(index, index + 2))
      keyboard.text(clock, `video_sched_pick:${clock.replace(":", "")}:${session.draftId}`);
    keyboard.row();
  }
  keyboard.text(t(locale, "video.enter-time-btn"), `video_sched_manual:${session.draftId}`).row();
  keyboard.text(t(locale, "common.cancel"), "video_cancel_dialog");
  return sendVideoControl(ctx, backendDb, actorId, session, text, keyboard);
}

export async function askSchedule(ctx: Context, backendDb: BackendDb, actorId: number, session: VideoSession): Promise<void> {
  const next = { ...session, step: "schedule_choice" };
  saveSession(backendDb, actorId, next);
  const locale = botLocale(backendDb, actorId);
  const keyboard = new InlineKeyboard().text(t(locale, "video.same-time"), `video_common:${session.draftId}`);
  if (session.selected.length > 1) keyboard.row().text(t(locale, "video.different-time"), `video_individual:${session.draftId}`);
  keyboard.row().text(t(locale, "common.cancel"), "video_cancel_dialog");
  await sendVideoControl(ctx, backendDb, actorId, next, t(locale, "video.saved-choose-schedule"), keyboard);
}

export function setControlFromSession(backendDb: BackendDb, draftId: number, ctx: Context, session: VideoSession): void {
  const messageId = Number(session.data.controlMessageId);
  if (messageId && ctx.chat?.id) setTelegramVideoCard(backendDb, draftId, Number(ctx.chat.id), messageId);
}

export function callbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  return message && "message_id" in message ? message.message_id : null;
}
