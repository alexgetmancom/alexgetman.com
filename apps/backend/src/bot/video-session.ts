import { eq, sql } from "drizzle-orm";
import { type Context, InlineKeyboard } from "grammy";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { videoBotSessions } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { t } from "../foundation/i18n/index.js";
import { setTelegramVideoCard } from "../interfaces/telegram/control-cards.js";
import { VIDEO_TARGETS, type VideoTarget, videoTargetLabel } from "../publishing/video-types.js";
import { nextVideoFlowStep, previousVideoMetadataStep, type VideoPrompt, type VideoWizardStep } from "../studio/video-fsm.js";
import { type BotLocale, botLocale } from "./i18n.js";
import { versionedCallback } from "./session-fsm.js";

const VIDEO_SESSION_TTL_MS = 30 * 60_000;
export type VideoSessionStep =
  | "locale"
  | "asset"
  | "targets"
  | "schedule_choice"
  | "schedule_common"
  | "schedule_confirm"
  | "label"
  | VideoWizardStep
  | `schedule_target:${VideoTarget}`;
export type VideoSession = {
  draftId: number | null;
  step: VideoSessionStep;
  selected: VideoTarget[];
  data: Record<string, unknown>;
  revision: number;
};
export type VideoSessionInput = Omit<VideoSession, "revision"> & Partial<Pick<VideoSession, "revision">>;

const STATIC_VIDEO_SESSION_STEPS = new Set<VideoSessionStep>([
  "locale",
  "asset",
  "targets",
  "schedule_choice",
  "schedule_common",
  "schedule_confirm",
  "label",
  "youtube_title",
  "youtube_description",
  "youtube_game_url",
  "youtube_tags",
  "instagram_caption",
]);

export function targetKeyboard(config: BackendConfig, selected: VideoTarget[], locale: BotLocale, revision?: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const target of enabledVideoTargets(config)) {
    keyboard
      .text(`${selected.includes(target) ? "✓" : "○"} ${videoTargetLabel(target)}`, versionedCallback(`video_toggle:${target}`, revision))
      .row();
  }
  return keyboard
    .text(t(locale, "video.next"), versionedCallback("video_targets_done", revision))
    .row()
    .text(t(locale, "common.cancel"), versionedCallback("video_cancel_dialog", revision));
}

export function enabledVideoTargets(config: BackendConfig): VideoTarget[] {
  return VIDEO_TARGETS.filter(
    (target) =>
      (target !== "youtube_shorts" || config.studio.modules.youtube) && (target !== "instagram_reels" || config.studio.modules.instagram),
  );
}

export function getSession(backendDb: BackendDb, actorId: number): VideoSession | null {
  const row = unsafeDb(backendDb).db.select().from(videoBotSessions).where(eq(videoBotSessions.actorId, actorId)).get();
  if (!row || row.active === 0) return null;
  if (row) {
    const expiresAt = row.expiresAt ? Date.parse(row.expiresAt) : Date.parse(row.updatedAt) + VIDEO_SESSION_TTL_MS;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      clearSession(backendDb, actorId);
      return null;
    }
  }
  const step = parseVideoSessionStep(row.step);
  const selected = parseSelectedTargets(row.selectedTargetsJson);
  const data = row.dataJson;
  if (!step || !selected || !data || typeof data !== "object" || Array.isArray(data)) {
    clearSession(backendDb, actorId);
    return null;
  }
  return { draftId: row.videoDraftId, step, selected, data: data as Record<string, unknown>, revision: row.revision };
}

export function saveSession(backendDb: BackendDb, actorId: number, session: VideoSessionInput): VideoSession {
  const existing = unsafeDb(backendDb).db.select().from(videoBotSessions).where(eq(videoBotSessions.actorId, actorId)).get();
  if (existing && session.revision != null && existing.revision !== session.revision) throw new StudioError("action.session-stale");
  const revision = existing && !hasSemanticChange(existing, session) ? existing.revision : (existing?.revision ?? 0) + 1;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + VIDEO_SESSION_TTL_MS).toISOString();
  unsafeDb(backendDb)
    .db.insert(videoBotSessions)
    .values({
      actorId,
      videoDraftId: session.draftId,
      step: session.step,
      selectedTargetsJson: session.selected,
      dataJson: session.data,
      revision,
      active: 1,
      updatedAt: now,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: videoBotSessions.actorId,
      set: {
        videoDraftId: session.draftId,
        step: session.step,
        selectedTargetsJson: session.selected,
        dataJson: session.data,
        revision,
        active: 1,
        updatedAt: now,
        expiresAt,
      },
    })
    .run();
  return { ...session, revision };
}

export function setData(
  backendDb: BackendDb,
  actorId: number,
  session: VideoSession,
  key: string,
  value: unknown,
  nextStep: VideoSessionStep,
): VideoSession {
  const next = { ...session, step: nextStep, data: { ...session.data, [key]: value } };
  return saveSession(backendDb, actorId, next);
}

export function clearSession(backendDb: BackendDb, actorId: number): void {
  unsafeDb(backendDb)
    .db.update(videoBotSessions)
    .set({ active: 0, revision: sql`${videoBotSessions.revision} + 1`, updatedAt: new Date().toISOString(), expiresAt: null })
    .where(eq(videoBotSessions.actorId, actorId))
    .run();
}

export async function updateVideoControl(
  ctx: Context,
  session: VideoSession,
  text: string,
  keyboard: InlineKeyboard | undefined,
  locale: BotLocale,
): Promise<void> {
  const messageId = Number(session.data.controlMessageId);
  const replyMarkup =
    keyboard ?? new InlineKeyboard().text(t(locale, "common.cancel"), versionedCallback("video_cancel_dialog", session.revision));
  if (messageId && ctx.chat?.id)
    return void (await ctx.api.editMessageText(ctx.chat.id, messageId, text, { parse_mode: "Markdown", reply_markup: replyMarkup }));
  await ctx.reply(text, { parse_mode: "Markdown", reply_markup: replyMarkup });
}

/** Sends the next question as a normal chat message, without moving an earlier
 * control card. Always offers Cancel so a free-text prompt is never a dead end.
 * Pass `plainText` for anything carrying an error message: those embed raw
 * paths and API responses whose `_` and `*` make Telegram reject the whole
 * send as unparsable Markdown, losing exactly the text worth reading. */
export async function replyVideoPrompt(
  ctx: Context,
  backendDb: BackendDb,
  actorId: number,
  locale: BotLocale,
  text: string,
  options?: { plainText?: boolean },
): Promise<void> {
  const revision = getSession(backendDb, actorId)?.revision;
  await ctx.reply(text, {
    ...(options?.plainText ? {} : { parse_mode: "Markdown" }),
    reply_markup: new InlineKeyboard().text(t(locale, "common.cancel"), versionedCallback("video_cancel_dialog", revision)),
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
  const revision = getSession(backendDb, actorId)?.revision;
  const keyboard = new InlineKeyboard();
  if (step === "youtube_game_url") keyboard.text(t(locale, "video.skip"), versionedCallback("video_game_skip", revision));
  if (previousVideoMetadataStep(step, selected)) keyboard.text(t(locale, "common.back"), versionedCallback("video_meta_back", revision));
  keyboard.text(t(locale, "common.cancel"), versionedCallback("video_cancel_dialog", revision));
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
  if (session.draftId != null && ctx.chat?.id != null)
    setTelegramVideoCard(backendDb, session.draftId, Number(ctx.chat.id), message.message_id);
  const next: VideoSessionInput = { ...session, data: { ...session.data, controlMessageId: message.message_id } };
  return saveSession(backendDb, actorId, next);
}

export async function askInstagramOrSchedule(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoSession,
): Promise<void> {
  if (nextVideoFlowStep(session.selected) === "instagram_caption") {
    const next: VideoSession = { ...session, step: "instagram_caption" };
    saveSession(backendDb, actorId, next);
    await sendVideoMetadataPrompt(ctx, backendDb, actorId, "instagram_caption", session.selected);
    return;
  }
  await askSchedule(ctx, backendDb, config, actorId, session);
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
  const revision = getSession(backendDb, actorId)?.revision ?? session.revision;
  const keyboard = new InlineKeyboard();
  for (let index = 0; index < VIDEO_SLOT_PRESETS.length; index += 2) {
    for (const clock of VIDEO_SLOT_PRESETS.slice(index, index + 2))
      keyboard.text(clock, versionedCallback(`video_sched_pick:${clock.replace(":", "")}:${session.draftId}`, revision));
    keyboard.row();
  }
  keyboard.text(t(locale, "video.enter-time-btn"), versionedCallback(`video_sched_manual:${session.draftId}`, revision)).row();
  keyboard.text(t(locale, "common.cancel"), versionedCallback("video_cancel_dialog", revision));
  return sendVideoControl(ctx, backendDb, actorId, session, text, keyboard);
}

export async function askSchedule(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoSession,
): Promise<void> {
  const next = saveSession(backendDb, actorId, { ...session, step: "schedule_choice" });
  const locale = botLocale(backendDb, actorId);
  const keyboard = new InlineKeyboard().text(
    t(locale, "video.same-time"),
    versionedCallback(`video_common:${session.draftId}`, next.revision),
  );
  if (session.selected.length > 1)
    keyboard.row().text(t(locale, "video.different-time"), versionedCallback(`video_individual:${session.draftId}`, next.revision));
  keyboard.row().text(t(locale, "common.cancel"), versionedCallback("video_cancel_dialog", next.revision));
  await sendVideoControl(
    ctx,
    backendDb,
    actorId,
    next,
    t(locale, "video.saved-choose-schedule", { timezone: config.TIMEZONE_LABEL }),
    keyboard,
  );
}

export function setControlFromSession(backendDb: BackendDb, draftId: number, ctx: Context, session: VideoSession): void {
  const messageId = Number(session.data.controlMessageId);
  if (messageId && ctx.chat?.id) setTelegramVideoCard(backendDb, draftId, Number(ctx.chat.id), messageId);
}

export function callbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  return message && "message_id" in message ? message.message_id : null;
}

export function parseVideoSessionStep(value: string): VideoSessionStep | null {
  if (STATIC_VIDEO_SESSION_STEPS.has(value as VideoSessionStep)) return value as VideoSessionStep;
  return /^schedule_target:(youtube_shorts|instagram_reels)$/.test(value) ? (value as VideoSessionStep) : null;
}

function parseSelectedTargets(value: unknown): VideoTarget[] | null {
  if (!Array.isArray(value)) return null;
  if (new Set(value).size !== value.length) return null;
  return value.every((target): target is VideoTarget => typeof target === "string" && VIDEO_TARGETS.includes(target as VideoTarget))
    ? value
    : null;
}

function hasSemanticChange(row: typeof videoBotSessions.$inferSelect, session: VideoSessionInput): boolean {
  return (
    row.active !== 1 ||
    row.videoDraftId !== session.draftId ||
    row.step !== session.step ||
    JSON.stringify(row.selectedTargetsJson) !== JSON.stringify(session.selected) ||
    JSON.stringify(withoutPresentationData(row.dataJson)) !== JSON.stringify(withoutPresentationData(session.data))
  );
}

function withoutPresentationData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const { controlMessageId: _controlMessageId, ...semantic } = value as Record<string, unknown>;
  return semantic;
}
