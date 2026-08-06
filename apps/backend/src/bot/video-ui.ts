import { type Context, InlineKeyboard } from "grammy";
import { backFlow } from "../application/conversation-flow.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { type MessageKey, t } from "../foundation/i18n/index.js";
import { manualScheduleExample } from "../foundation/time.js";
import { VIDEO_TARGETS, type VideoTarget, videoTargetLabel } from "../publishing/video-types.js";
import { createStudioServices, type StudioServices } from "../studio/services/index.js";
import { isVideoWizardStep, VIDEO_FLOW, type VideoConversationStep, type VideoWizardStep } from "../studio/video-fsm.js";
import { type ConversationState, clearConversationState, getConversationState, saveConversationState } from "./conversation-state.js";
import { appendCancelButton, cancelPromptKeyboard } from "./dialog-ui.js";
import type { PublicationEffect } from "./effects.js";
import { type BotLocale, botLocale } from "./i18n.js";
import { publicationCallback, versionedCallback } from "./publication-callback.js";
import { createPublicationScheduleEngine, SCHEDULE_SLOT_PRESETS, scheduleConfirmationEffects, scheduleTimeKeyboard } from "./scheduling.js";

export type { VideoConversationStep } from "../studio/video-fsm.js";
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
        publicationCallback("video", "wizard_toggle", [target], revision),
      )
      .row();
  }
  keyboard.text(t(locale, "video.next"), publicationCallback("video", "targets_done", [], revision)).row();
  return appendCancelButton(keyboard, locale, publicationCallback("video", "cancel_dialog"), revision);
}

export function startVideoEffects(ctx: Context, backendDb: BackendDb, actorId: number, locale: BotLocale): PublicationEffect[] {
  const session = saveVideoState(backendDb, actorId, { draftId: null, step: "locale", selected: [], data: {}, controlMessageId: null });
  const keyboard = new InlineKeyboard()
    .text(t(locale, "video.language-ru"), publicationCallback("video", "locale", ["ru"], session.revision))
    .text(t(locale, "video.language-en"), publicationCallback("video", "locale", ["en"], session.revision))
    .row();
  appendCancelButton(keyboard, locale, publicationCallback("video", "cancel_dialog"), session.revision);
  return [
    {
      type: "screen",
      mode: ctx.callbackQuery?.message ? "edit" : "reply",
      text: t(locale, "video.choose-language"),
      options: { reply_markup: keyboard },
    },
  ];
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
  const step = parseVideoStep(state.step);
  if (!step) {
    clearVideoState(backendDb, actorId);
    return null;
  }
  const selected = state.data.selectedTargets === undefined ? [] : parseSelectedTargets(state.data.selectedTargets);
  if (!selected) {
    clearVideoState(backendDb, actorId);
    return null;
  }
  return { ...state, step, selected };
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
  return { ...saved, step: session.step, selected: session.selected };
}

export function clearVideoState(backendDb: BackendDb, actorId: number): void {
  clearConversationState(backendDb, actorId, "video");
}

export function videoPromptEffect(backendDb: BackendDb, actorId: number, text: string, plainText = false): PublicationEffect {
  const locale = botLocale(backendDb, actorId);
  const revision = getVideoState(backendDb, actorId)?.revision;
  return {
    type: "prompt",
    text,
    options: {
      ...(plainText ? {} : { parse_mode: "Markdown" }),
      reply_markup: cancelPromptKeyboard(locale, publicationCallback("video", "cancel_dialog"), revision),
    },
  };
}

/** Renders whatever the flow's current step asks the operator for. Every path
 * that advances the wizard — a typed message or a tapped control — ends here
 * with the step the transition produced, so no caller decides for itself which
 * question comes next or how it looks. */
export function videoStepEffects(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoConversationState,
): PublicationEffect[] {
  const step = session.step;
  const locale = botLocale(backendDb, actorId);
  const timeConfig = createStudioServices(backendDb, config).settings.timeConfig(actorId, config);
  if (isVideoWizardStep(step)) return metadataPromptEffects(backendDb, actorId, step, session.selected);
  if (step === "schedule_choice")
    return scheduleChoiceEffects(session, locale, t(locale, "video.saved-choose-schedule", { timezone: timeConfig.TIMEZONE_LABEL }));
  if (step === "schedule_common")
    return videoTimeEffects(
      backendDb,
      actorId,
      session,
      t(locale, "video.enter-datetime", {
        timezone: timeConfig.TIMEZONE_LABEL,
        example: manualScheduleExample(timeConfig.TIMEZONE, backendDb.clock.now()),
      }),
    );
  if (step === "schedule_target") {
    const target = session.data.target;
    if (typeof target !== "string" || !VIDEO_TARGETS.includes(target as VideoTarget)) throw new StudioError("err.video-no-platforms");
    return videoTimeEffects(
      backendDb,
      actorId,
      session,
      t(locale, "video.schedule-target-prompt", {
        target: videoTargetLabel(target as VideoTarget),
        timezone: timeConfig.TIMEZONE_LABEL,
        example: manualScheduleExample(timeConfig.TIMEZONE, backendDb.clock.now()),
      }),
    );
  }
  throw new StudioError("err.video-restart");
}

function metadataPromptEffects(backendDb: BackendDb, actorId: number, step: VideoWizardStep, selected: VideoTarget[]): PublicationEffect[] {
  const locale = botLocale(backendDb, actorId);
  const revision = getVideoState(backendDb, actorId)?.revision;
  const keyboard = new InlineKeyboard();
  if (step === "youtube_game_url") keyboard.text(t(locale, "video.skip"), publicationCallback("video", "game_skip", [], revision));
  if (backFlow(VIDEO_FLOW, step, { selectedTargets: selected }))
    keyboard.text(t(locale, "common.back"), publicationCallback("video", "meta_back", [], revision));
  appendCancelButton(keyboard, locale, publicationCallback("video", "cancel_dialog"), revision);
  return [{ type: "prompt", text: videoPrompt(locale, step), options: { reply_markup: keyboard } }];
}

const VIDEO_METADATA_PROMPTS: Record<VideoWizardStep, MessageKey> = {
  youtube_title: "video.prompt-yt-title",
  youtube_description: "video.prompt-yt-description",
  youtube_game_url: "video.prompt-yt-game-url",
  youtube_tags: "video.prompt-yt-tags",
  instagram_caption: "video.prompt-ig-caption",
};

function videoPrompt(locale: BotLocale, prompt: VideoWizardStep): string {
  return t(locale, VIDEO_METADATA_PROMPTS[prompt]);
}

export function videoControlEffects(session: VideoConversationState, text: string, keyboard: InlineKeyboard): PublicationEffect[] {
  const card = session.draftId == null ? undefined : { kind: "video" as const, draftId: session.draftId };
  return [{ type: "prompt", text, options: { parse_mode: "Markdown", reply_markup: keyboard }, ...(card ? { card } : {}) }];
}

function videoTimeEffects(backendDb: BackendDb, actorId: number, session: VideoConversationState, text: string): PublicationEffect[] {
  const locale = botLocale(backendDb, actorId);
  const revision = getVideoState(backendDb, actorId)?.revision ?? session.revision;
  const engine = createPublicationScheduleEngine({
    kind: "video",
    publicationId: session.draftId ?? 0,
    scheduleAxis: "target",
    axisKeys: session.selected,
    axisLabel: videoTargetLabel,
    slotValues: SCHEDULE_SLOT_PRESETS,
  });
  const keyboard = scheduleTimeKeyboard({
    axis: engine.axis,
    revision,
    manual: { label: t(locale, "video.enter-time-btn"), callback: engine.manualCallback() },
    cancel: { label: t(locale, "common.cancel"), callback: publicationCallback("video", "cancel_dialog") },
  });
  return videoControlEffects(session, text, keyboard);
}

/** Expects the session to already sit on `schedule_choice`: the caller applied
 * the transition that got here, and saving again only burns a revision the
 * keyboard below would then be built against. */
function scheduleChoiceEffects(session: VideoConversationState, locale: BotLocale, text: string): PublicationEffect[] {
  const { revision } = session;
  const keyboard = new InlineKeyboard().text(
    t(locale, "video.same-time"),
    publicationCallback("video", "common", [session.draftId ?? ""], revision),
  );
  if (session.selected.length > 1)
    keyboard.row().text(t(locale, "video.different-time"), publicationCallback("video", "individual", [session.draftId ?? ""], revision));
  keyboard.row();
  appendCancelButton(keyboard, locale, publicationCallback("video", "cancel_dialog"), revision);
  return videoControlEffects(session, text, keyboard);
}

/** Moves the session to `schedule_confirm` and renders the per-target summary
 * with its confirm/back keyboard. Shared because the schedule can be completed
 * from either transport path — slot buttons (callbacks) or a typed date
 * (messages) — and both must land on the identical confirmation. */
export function videoScheduleConfirmationEffects(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoConversationState,
  schedule: Partial<Record<VideoTarget, Date>>,
  services: StudioServices,
): PublicationEffect[] {
  const { draftId } = session;
  if (!draftId) throw new StudioError("err.video-missing");
  const locale = botLocale(backendDb, actorId);
  const videos = services.videos;
  const timeConfig = services.settings.timeConfig(actorId, config);
  // The transition runner already saved the `schedule_confirm` session. This
  // renderer must only derive Telegram effects, otherwise one user action
  // would consume two revisions and invalidate its own buttons.
  const next = session;
  const entries = next.selected.flatMap((target) => {
    const value = schedule[target];
    return value ? [{ key: target, value }] : [];
  });
  const engine = createPublicationScheduleEngine({
    kind: "video",
    publicationId: draftId,
    scheduleAxis: videos.capabilities.scheduleAxis,
    axisKeys: next.selected,
    axisLabel: videoTargetLabel,
    slotValues: [],
  });
  return scheduleConfirmationEffects({
    kind: "video",
    publicationId: draftId,
    revision: next.revision,
    title: t(locale, "common.confirm-schedule"),
    titlePrefix: "🎬",
    entries,
    label: videoTargetLabel,
    formatValue: (value) =>
      `${value.toLocaleString(locale === "ru" ? "ru-RU" : "en-GB", { timeZone: timeConfig.TIMEZONE })} ${timeConfig.TIMEZONE_LABEL}`,
    confirm: { label: t(locale, "common.confirm"), callback: engine.confirmCallback() },
    back: { label: t(locale, "common.back"), callback: publicationCallback("video", "schedule", [draftId]) },
    effects: [{ type: "delivery-previews", projections: videos.preview(actorId, draftId).delivery.projections, locale }],
  });
}

export function parseVideoStep(value: string): VideoConversationStep | null {
  return Object.keys(VIDEO_FLOW.steps).find((step): step is VideoConversationStep => step === value) ?? null;
}

function parseSelectedTargets(value: unknown): VideoTarget[] | null {
  if (!Array.isArray(value)) return null;
  if (new Set(value).size !== value.length) return null;
  return value.every((target): target is VideoTarget => typeof target === "string" && VIDEO_TARGETS.includes(target as VideoTarget))
    ? value
    : null;
}
