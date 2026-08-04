import { type Context, InlineKeyboard } from "grammy";
import type { ConversationSessionRecord } from "../application/ports.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import { setTelegramVideoCard } from "../interfaces/telegram/control-cards.js";
import { VIDEO_TARGETS, type VideoTarget, videoTargetLabel } from "../publishing/video-types.js";
import { nextVideoFlowStep, previousVideoMetadataStep, VIDEO_FLOW, type VideoPrompt, type VideoWizardStep } from "../studio/video-fsm.js";
import {
  activeConversationSession,
  CONVERSATION_SESSION_TTL_MS,
  retireConversationSession,
  saveConversationSession,
} from "./conversation-session.js";
import { appendCancelButton, cancelPromptKeyboard } from "./dialog-ui.js";
import { type BotLocale, botLocale } from "./i18n.js";
import { SCHEDULE_SLOT_PRESETS, scheduleTimeKeyboard } from "./scheduling.js";
import { publicationCallback } from "./session-fsm.js";

export type VideoSessionStep =
  | "locale"
  | "asset"
  | "targets"
  | "schedule_choice"
  | "schedule_common"
  | "schedule_target"
  | "schedule_confirm"
  | "label"
  | VideoWizardStep;
export type VideoSession = {
  draftId: number | null;
  step: VideoSessionStep;
  selected: VideoTarget[];
  data: Record<string, unknown>;
  controlMessageId?: number | null;
  revision: number;
};
export type VideoSessionInput = Omit<VideoSession, "revision" | "controlMessageId"> &
  Partial<Pick<VideoSession, "controlMessageId" | "revision">>;

export function targetKeyboard(config: BackendConfig, selected: VideoTarget[], locale: BotLocale, revision?: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const target of enabledVideoTargets(config)) {
    keyboard
      .text(
        `${selected.includes(target) ? "✓" : "○"} ${videoTargetLabel(target)}`,
        publicationCallback("video", "toggle", [target], revision),
      )
      .row();
  }
  keyboard.text(t(locale, "video.next"), publicationCallback("video", "targets_done", [], revision)).row();
  return appendCancelButton(keyboard, locale, publicationCallback("video", "cancel_dialog"), revision);
}

export function enabledVideoTargets(config: BackendConfig): VideoTarget[] {
  return VIDEO_TARGETS.filter(
    (target) =>
      (target !== "youtube_shorts" || config.studio.modules.youtube) && (target !== "instagram_reels" || config.studio.modules.instagram),
  );
}

export function getSession(backendDb: BackendDb, actorId: number): VideoSession | null {
  const row = activeConversationSession(backendDb, actorId, "video", CONVERSATION_SESSION_TTL_MS);
  if (!row || row.active === 0) return null;
  const step = row.step ? parseVideoSessionStep(row.step) : null;
  const selected = parseSelectedTargets(row.selectedTargets);
  const legacyTarget = legacyScheduleTarget(row.step);
  const storedData = withoutControlMessageData(row.data);
  const data = legacyTarget && storedData.target == null ? { ...storedData, target: legacyTarget } : storedData;
  if (!step || !selected || !data || typeof data !== "object" || Array.isArray(data)) {
    clearSession(backendDb, actorId);
    return null;
  }
  return {
    draftId: row.draftId,
    step,
    selected,
    data: data as Record<string, unknown>,
    controlMessageId: row.controlMessageId,
    revision: row.revision,
  };
}

export function saveSession(backendDb: BackendDb, actorId: number, session: VideoSessionInput): VideoSession {
  const existing = backendDb.conversationSessions.get(actorId, "video");
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CONVERSATION_SESSION_TTL_MS).toISOString();
  const revision = saveConversationSession(backendDb, {
    actorId,
    kind: "video",
    draftId: session.draftId,
    action: null,
    step: session.step,
    selectedTargets: session.selected,
    data: withoutControlMessageData(session.data),
    controlMessageId: session.controlMessageId ?? null,
    active: 1,
    ...(session.revision == null ? {} : { expectedRevision: session.revision }),
    preserveRevision: existing != null && !hasSemanticChange(existing, session),
    updatedAt: now,
    expiresAt,
  });
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
  retireConversationSession(backendDb, actorId, "video");
}

export async function updateVideoControl(
  ctx: Context,
  session: VideoSession,
  text: string,
  keyboard: InlineKeyboard | undefined,
  locale: BotLocale,
): Promise<void> {
  const messageId = session.controlMessageId;
  const replyMarkup = keyboard ?? cancelPromptKeyboard(locale, publicationCallback("video", "cancel_dialog"), session.revision);
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
    reply_markup: cancelPromptKeyboard(locale, publicationCallback("video", "cancel_dialog"), revision),
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
  if (step === "youtube_game_url") keyboard.text(t(locale, "video.skip"), publicationCallback("video", "game_skip", [], revision));
  if (previousVideoMetadataStep(step, selected))
    keyboard.text(t(locale, "common.back"), publicationCallback("video", "meta_back", [], revision));
  appendCancelButton(keyboard, locale, publicationCallback("video", "cancel_dialog"), revision);
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
  const next: VideoSessionInput = { ...session, controlMessageId: message.message_id };
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
  const keyboard = scheduleTimeKeyboard({
    axis: {
      values: SCHEDULE_SLOT_PRESETS,
      label: (clock) => clock,
      callback: (clock) => publicationCallback("video", "sched_pick", [session.draftId ?? "", clock.replace(":", "")]),
    },
    revision,
    manual: {
      label: t(locale, "video.enter-time-btn"),
      callback: publicationCallback("video", "sched_manual", [session.draftId ?? ""]),
    },
    cancel: { label: t(locale, "common.cancel"), callback: publicationCallback("video", "cancel_dialog") },
  });
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
    publicationCallback("video", "common", [session.draftId ?? ""], next.revision),
  );
  if (session.selected.length > 1)
    keyboard
      .row()
      .text(t(locale, "video.different-time"), publicationCallback("video", "individual", [session.draftId ?? ""], next.revision));
  keyboard.row();
  appendCancelButton(keyboard, locale, publicationCallback("video", "cancel_dialog"), next.revision);
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
  const messageId = session.controlMessageId;
  if (messageId && ctx.chat?.id) setTelegramVideoCard(backendDb, draftId, Number(ctx.chat.id), messageId);
}

export function callbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  return message && "message_id" in message ? message.message_id : null;
}

export function parseVideoSessionStep(value: string): VideoSessionStep | null {
  if (value in VIDEO_FLOW.steps) return value as VideoSessionStep;
  return legacyScheduleTarget(value) ? "schedule_target" : null;
}

function legacyScheduleTarget(value: string | null): VideoTarget | null {
  const target = value?.match(/^schedule_target:(youtube_shorts|instagram_reels)$/)?.[1];
  return target && VIDEO_TARGETS.includes(target as VideoTarget) ? (target as VideoTarget) : null;
}

function parseSelectedTargets(value: unknown): VideoTarget[] | null {
  if (!Array.isArray(value)) return null;
  if (new Set(value).size !== value.length) return null;
  return value.every((target): target is VideoTarget => typeof target === "string" && VIDEO_TARGETS.includes(target as VideoTarget))
    ? value
    : null;
}

function hasSemanticChange(row: ConversationSessionRecord, session: VideoSessionInput): boolean {
  return (
    row.active !== 1 ||
    row.draftId !== session.draftId ||
    row.step !== session.step ||
    JSON.stringify(row.selectedTargets) !== JSON.stringify(session.selected) ||
    JSON.stringify(withoutControlMessageData(row.data)) !== JSON.stringify(withoutControlMessageData(session.data))
  );
}

function withoutControlMessageData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const { controlMessageId: _controlMessageId, ...semantic } = value as Record<string, unknown>;
  return semantic;
}
