import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import { setTelegramVideoCard } from "../interfaces/telegram/control-cards.js";
import { VIDEO_TARGETS, type VideoTarget, videoTargetLabel } from "../publishing/video-types.js";
import { nextVideoFlowStep, previousVideoMetadataStep, VIDEO_FLOW, type VideoWizardStep } from "../studio/video-fsm.js";
import { type ConversationState, clearConversationState, getConversationState, saveConversationState } from "./conversation-state.js";
import { appendCancelButton, cancelPromptKeyboard } from "./dialog-ui.js";
import { type BotLocale, botLocale } from "./i18n.js";
import { SCHEDULE_SLOT_PRESETS, scheduleTimeKeyboard } from "./scheduling.js";
import { publicationCallback } from "./session-fsm.js";

export type VideoConversationStep =
  | "locale"
  | "asset"
  | "targets"
  | "schedule_choice"
  | "schedule_common"
  | "schedule_target"
  | "schedule_confirm"
  | "label"
  | VideoWizardStep;
export type VideoConversationState = ConversationState & {
  step: VideoConversationStep;
  selected: VideoTarget[];
};
export type VideoConversationInput = Omit<VideoConversationState, "kind" | "revision" | "controlMessageId"> &
  Partial<Pick<VideoConversationState, "controlMessageId" | "revision">>;

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

export function getVideoState(backendDb: BackendDb, actorId: number): VideoConversationState | null {
  const state = getConversationState(backendDb, actorId, "video");
  if (!state) return null;
  if (!(state.step in VIDEO_FLOW.steps)) {
    clearVideoState(backendDb, actorId);
    return null;
  }
  const selected = state.data.selectedTargets === undefined ? [] : parseSelectedTargets(state.data.selectedTargets);
  if (!selected) {
    clearVideoState(backendDb, actorId);
    return null;
  }
  return { ...state, step: state.step as VideoConversationStep, selected };
}

export function saveVideoState(backendDb: BackendDb, actorId: number, session: VideoConversationInput): VideoConversationState {
  const saved = saveConversationState(backendDb, actorId, {
    kind: "video",
    draftId: session.draftId,
    step: session.step,
    data: { ...session.data, selectedTargets: session.selected },
    controlMessageId: session.controlMessageId ?? null,
    ...(session.revision == null ? {} : { revision: session.revision }),
  });
  return { ...saved, step: saved.step as VideoConversationStep, selected: session.selected };
}

export function setVideoData(
  backendDb: BackendDb,
  actorId: number,
  session: VideoConversationState,
  key: string,
  value: unknown,
  nextStep: VideoConversationStep,
): VideoConversationState {
  const next = { ...session, step: nextStep, data: { ...session.data, [key]: value } };
  return saveVideoState(backendDb, actorId, next);
}

export function clearVideoState(backendDb: BackendDb, actorId: number): void {
  clearConversationState(backendDb, actorId, "video");
}

export async function updateVideoControl(
  ctx: Context,
  session: VideoConversationState,
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
  const revision = getVideoState(backendDb, actorId)?.revision;
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
  const revision = getVideoState(backendDb, actorId)?.revision;
  const keyboard = new InlineKeyboard();
  if (step === "youtube_game_url") keyboard.text(t(locale, "video.skip"), publicationCallback("video", "game_skip", [], revision));
  if (previousVideoMetadataStep(step, selected))
    keyboard.text(t(locale, "common.back"), publicationCallback("video", "meta_back", [], revision));
  appendCancelButton(keyboard, locale, publicationCallback("video", "cancel_dialog"), revision);
  await ctx.reply(videoPrompt(locale, step), { reply_markup: keyboard });
}

function videoPrompt(locale: BotLocale, prompt: VideoWizardStep): string {
  if (prompt === "youtube_title") return t(locale, "video.prompt-yt-title");
  if (prompt === "youtube_description") return t(locale, "video.prompt-yt-description");
  if (prompt === "youtube_game_url") return t(locale, "video.prompt-yt-game-url");
  if (prompt === "youtube_tags") return t(locale, "video.prompt-yt-tags");
  if (prompt === "instagram_caption") return t(locale, "video.prompt-ig-caption");
  throw new Error(`Unsupported video metadata step: ${prompt}`);
}

/**
 * Sends a temporary interactive card and remembers only that card for checkbox/schedule edits.
 * Regular questions deliberately use replyVideoPrompt so the conversation stays at the bottom.
 */
export async function sendVideoControl(
  ctx: Context,
  backendDb: BackendDb,
  actorId: number,
  session: VideoConversationState,
  text: string,
  keyboard: InlineKeyboard,
): Promise<VideoConversationState> {
  const message = await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
  if (session.draftId != null && ctx.chat?.id != null)
    setTelegramVideoCard(backendDb, session.draftId, Number(ctx.chat.id), message.message_id);
  const next: VideoConversationInput = { ...session, controlMessageId: message.message_id };
  return saveVideoState(backendDb, actorId, next);
}

export async function askInstagramOrSchedule(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoConversationState,
): Promise<void> {
  if (nextVideoFlowStep(session.selected) === "instagram_caption") {
    const next: VideoConversationState = { ...session, step: "instagram_caption" };
    saveVideoState(backendDb, actorId, next);
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
  session: VideoConversationState,
  text: string,
): Promise<VideoConversationState> {
  const locale = botLocale(backendDb, actorId);
  const revision = getVideoState(backendDb, actorId)?.revision ?? session.revision;
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
  session: VideoConversationState,
): Promise<void> {
  const next = saveVideoState(backendDb, actorId, { ...session, step: "schedule_choice" });
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

export function setControlFromSession(backendDb: BackendDb, draftId: number, ctx: Context, session: VideoConversationState): void {
  const messageId = session.controlMessageId;
  if (messageId && ctx.chat?.id) setTelegramVideoCard(backendDb, draftId, Number(ctx.chat.id), messageId);
}

export function callbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  return message && "message_id" in message ? message.message_id : null;
}

export function parseVideoStep(value: string): VideoConversationStep | null {
  if (value in VIDEO_FLOW.steps) return value as VideoConversationStep;
  return null;
}

function parseSelectedTargets(value: unknown): VideoTarget[] | null {
  if (!Array.isArray(value)) return null;
  if (new Set(value).size !== value.length) return null;
  return value.every((target): target is VideoTarget => typeof target === "string" && VIDEO_TARGETS.includes(target as VideoTarget))
    ? value
    : null;
}
