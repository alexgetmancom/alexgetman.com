import { type Context, InlineKeyboard } from "grammy";
import { acceptFlow } from "../application/conversation-flow.js";
import { fixUrlSlashes } from "../content/message.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { describeError, t } from "../foundation/i18n/index.js";
import { log } from "../foundation/logger.js";
import { storeTelegramVideo } from "../interfaces/telegram/video-ingress.js";
import { videoPreview } from "../interfaces/telegram/video-preview.js";
import { VIDEO_TARGETS, type VideoMetadata, type VideoTarget, videoTargetLabel } from "../publishing/video-types.js";
import { createStudioServices } from "../studio/services/index.js";
import {
  advanceVideoMetadata,
  advanceVideoTargetSchedule,
  commonVideoSchedule,
  firstVideoMetadataStep,
  VIDEO_FLOW,
  type VideoWizardStep,
} from "../studio/video-fsm.js";
import { appendCancelButton, confirmationKeyboard } from "./dialog-ui.js";
import { executePublicationEffects, type PublicationEffect, type PublicationMessageResult } from "./effects.js";
import { botLocale } from "./i18n.js";
import { publicationCallback } from "./session-fsm.js";
import {
  clearVideoState,
  enabledVideoTargets,
  getVideoState,
  metadataPromptEffects,
  saveVideoState,
  scheduleChoiceEffects,
  setVideoData,
  targetKeyboard,
  type VideoConversationState,
  videoControlEffects,
  videoPromptEffect,
  videoTimeEffects,
} from "./video-ui.js";

type VideoMessageArgs = {
  ctx: Context;
  backendDb: BackendDb;
  config: BackendConfig;
  actorId: number;
  session: VideoConversationState;
  text: string;
};
type VideoMessageHandler = (args: VideoMessageArgs) => Promise<PublicationEffect[]>;
type VideoMessageHandlerDefinition = { handle: VideoMessageHandler; requiresText: boolean };

const VIDEO_MESSAGE_HANDLERS: Record<string, VideoMessageHandlerDefinition> = {
  asset: { handle: handleAssetMessage, requiresText: false },
  label: { handle: handleLabelMessage, requiresText: true },
  youtube_title: { handle: handleLinearMetadataMessage, requiresText: true },
  youtube_description: { handle: handleLinearMetadataMessage, requiresText: true },
  youtube_game_url: { handle: handleLinearMetadataMessage, requiresText: true },
  youtube_tags: { handle: handleYoutubeTagsMessage, requiresText: true },
  instagram_caption: { handle: handleInstagramCaptionMessage, requiresText: true },
  schedule_common: { handle: handleScheduleMessage, requiresText: true },
  schedule_target: { handle: handleScheduleMessage, requiresText: true },
};

/** Starts and advances the MP4 → metadata → schedule conversation. */
export async function startVideoConversation(ctx: Context, backendDb: BackendDb): Promise<void> {
  const actorId = Number(ctx.from?.id);
  const locale = botLocale(backendDb, actorId);
  const text = t(locale, "video.choose-language");
  const session = saveVideoState(backendDb, actorId, { draftId: null, step: "locale", selected: [], data: {}, controlMessageId: null });
  const keyboard = new InlineKeyboard()
    .text(t(locale, "video.language-ru"), publicationCallback("video", "locale", ["ru"], session.revision))
    .text(t(locale, "video.language-en"), publicationCallback("video", "locale", ["en"], session.revision))
    .row();
  appendCancelButton(keyboard, locale, publicationCallback("video", "cancel_dialog"), session.revision);
  // Reached via a menu button, this is pure navigation: turn that same
  // message into the prompt instead of leaving it and adding a new one.
  await executePublicationEffects(ctx, backendDb, [
    { type: "screen", mode: ctx.callbackQuery?.message ? "edit" : "reply", text, options: { reply_markup: keyboard } },
  ]);
}

export async function handleVideoConversationMessage(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
): Promise<PublicationMessageResult> {
  if (!config.studio.modules.video_posting) return { handled: false, effects: [] };
  const actorId = Number(ctx.from?.id);
  const session = getVideoState(backendDb, actorId);
  if (!session) return { handled: false, effects: [] };
  const handler = VIDEO_MESSAGE_HANDLERS[session.step];
  if (!handler) return { handled: false, effects: [] };
  try {
    const text = ctx.message && "text" in ctx.message ? (ctx.message.text?.trim() ?? "") : "";
    if (handler.requiresText && !text) {
      const locale = botLocale(backendDb, actorId);
      return { handled: true, effects: [videoPromptEffect(backendDb, actorId, t(locale, "video.await-text"))] };
    }
    const edit =
      session.data.is_single_edit && handler.requiresText ? singleEditChange(backendDb, config, actorId, session.step, text) : null;
    const effects = edit
      ? await finishSingleVideoEdit(backendDb, config, actorId, session, edit.target, edit.apply)
      : await handler.handle({ ctx, backendDb, config, actorId, session, text });
    return { handled: true, effects };
  } catch (error) {
    const locale = botLocale(backendDb, actorId);
    // The original error is operationally important (disk, Telegram download,
    // media import, Studio validation), and the admin reply can still be lost to
    // a Telegram send failure — log it first so the cause survives regardless.
    // `step` is what says which part of the conversation this was.
    log("error", "Video conversation step failed", {
      actorId,
      step: session.step,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      handled: true,
      effects: [videoPromptEffect(backendDb, actorId, `🔴 ${t(locale, "video.value-error")}: ${describeError(locale, error)}`, true)],
    };
  }
}

async function handleAssetMessage({ ctx, backendDb, config, actorId, session }: VideoMessageArgs): Promise<PublicationEffect[]> {
  const stored = await storeTelegramVideo(ctx, backendDb, config, actorId);
  const draftId = createStudioServices(backendDb, config).videos.create(
    actorId,
    stored.assetId,
    session.data.videoLocale === "en" ? "en" : "ru",
  );
  const selected = enabledVideoTargets(config);
  if (!selected.length) throw new StudioError("err.no-video-platforms-config");
  createStudioServices(backendDb, config).videos.replaceTargets(actorId, draftId, selected);
  const first = firstVideoMetadataStep(selected);
  const transition = await acceptFlow(VIDEO_FLOW, "asset", stored.assetId, { ...session.data, selectedTargets: selected });
  if (!transition?.next) throw new StudioError("err.video-restart");
  const next: VideoConversationState = { ...session, draftId, step: first, selected, data: transition.data };
  saveVideoState(backendDb, actorId, next);
  return metadataPromptEffects(backendDb, actorId, first, selected);
}

async function handleLabelMessage({ backendDb, config, actorId, session, text }: VideoMessageArgs): Promise<PublicationEffect[]> {
  if (session.draftId == null) return [];
  createStudioServices(backendDb, config).videos.rename(actorId, session.draftId, text);
  if (session.data.is_single_edit) {
    clearVideoState(backendDb, actorId);
    const locale = botLocale(backendDb, actorId);
    const preview = videoPreview(createStudioServices(backendDb, config).videos.preview(actorId, session.draftId), config, locale);
    return [
      {
        type: "screen",
        mode: "reply",
        text: preview.text,
        options: { parse_mode: "Markdown", reply_markup: preview.keyboard },
        card: { kind: "video", draftId: session.draftId },
      },
    ];
  }
  const transition = await acceptFlow(VIDEO_FLOW, "label", text, { ...session.data, selectedTargets: session.selected });
  if (!transition?.next) throw new StudioError("err.video-restart");
  const next: VideoConversationState = { ...session, step: transition.next as VideoConversationState["step"], data: transition.data };
  const saved = saveVideoState(backendDb, actorId, next);
  return videoControlEffects(
    saved,
    t(botLocale(backendDb, actorId), "video.choose-platforms-next"),
    targetKeyboard(config, saved.selected, botLocale(backendDb, actorId), saved.revision),
  );
}

async function handleLinearMetadataMessage({ backendDb, actorId, session, text }: VideoMessageArgs): Promise<PublicationEffect[]> {
  if (session.draftId == null) return [];
  const step = session.step as VideoWizardStep;
  const transition = await acceptFlow(VIDEO_FLOW, step, text, { ...session.data, selectedTargets: session.selected });
  if (!transition?.next) throw new StudioError("err.video-restart");
  const data = withoutFlowData(transition.data);
  setVideoData(backendDb, actorId, session, step, data[step], transition.next as VideoConversationState["step"]);
  return metadataPromptEffects(backendDb, actorId, transition.next as VideoWizardStep, session.selected);
}

async function handleYoutubeTagsMessage({ backendDb, config, actorId, session, text }: VideoMessageArgs): Promise<PublicationEffect[]> {
  if (session.draftId == null) return [];
  const transition = await acceptFlow(VIDEO_FLOW, "youtube_tags", text, { ...session.data, selectedTargets: session.selected });
  if (!transition) throw new StudioError("err.video-restart");
  const tags = transition.data.youtube_tags as string[];
  const metadata = {
    title: String(session.data.youtube_title ?? ""),
    description: String(session.data.youtube_description ?? ""),
    ...(String(session.data.youtube_game_url ?? "") ? { gameUrl: String(session.data.youtube_game_url) } : {}),
    tags,
  };
  createStudioServices(backendDb, config).videos.updateMetadata(actorId, session.draftId, "youtube_shorts", metadata);
  createStudioServices(backendDb, config).videos.rename(actorId, session.draftId, metadata.title || "YouTube Shorts");
  const saved = saveVideoState(backendDb, actorId, { ...session, data: withoutFlowData(transition.data) });
  if (nextVideoStep(saved.selected) === "instagram_caption") {
    const next = saveVideoState(backendDb, actorId, { ...saved, step: "instagram_caption" });
    return metadataPromptEffects(backendDb, actorId, "instagram_caption", next.selected);
  }
  return scheduleChoiceEffects(
    backendDb,
    actorId,
    saved,
    botLocale(backendDb, actorId),
    t(botLocale(backendDb, actorId), "video.saved-choose-schedule", { timezone: config.TIMEZONE_LABEL }),
  );
}

async function handleInstagramCaptionMessage({
  backendDb,
  config,
  actorId,
  session,
  text,
}: VideoMessageArgs): Promise<PublicationEffect[]> {
  if (session.draftId == null) return [];
  const transition = await acceptFlow(VIDEO_FLOW, "instagram_caption", text, { ...session.data, selectedTargets: session.selected });
  if (!transition) throw new StudioError("err.video-restart");
  const metadata = { caption: String(transition.data.instagram_caption ?? "") };
  createStudioServices(backendDb, config).videos.updateMetadata(actorId, session.draftId, "instagram_reels", metadata);
  if (!session.selected.includes("youtube_shorts"))
    createStudioServices(backendDb, config).videos.rename(actorId, session.draftId, metadata.caption || "Instagram Reels");
  const saved = saveVideoState(backendDb, actorId, { ...session, data: withoutFlowData(transition.data) });
  return scheduleChoiceEffects(
    backendDb,
    actorId,
    saved,
    botLocale(backendDb, actorId),
    t(botLocale(backendDb, actorId), "video.saved-choose-schedule", { timezone: config.TIMEZONE_LABEL }),
  );
}

function nextVideoStep(selected: VideoTarget[]): "instagram_caption" | "schedule_choice" {
  return selected.includes("instagram_reels") ? "instagram_caption" : "schedule_choice";
}

function withoutFlowData(data: Record<string, unknown>): Record<string, unknown> {
  const { nextTarget: _nextTarget, ...persisted } = data;
  return persisted;
}

/** Table for editing one already-set metadata field outside the wizard order
 * (reached via "✏️ Edit" on a finished draft). Kept separate from the wizard
 * advance logic above so neither has to know about the other's entry point. */
function singleEditChange(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  step: string,
  text: string,
): { target: VideoTarget; apply: (metadata: Record<string, unknown>, draftId: number) => void } | null {
  const builder = SINGLE_EDIT_CHANGES[step];
  return builder ? builder(backendDb, config, actorId, text) : null;
}

type SingleEditBuilder = (
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  text: string,
) => { target: VideoTarget; apply: (metadata: Record<string, unknown>, draftId: number) => void };

const SINGLE_EDIT_CHANGES: Record<string, SingleEditBuilder> = {
  youtube_title: (_backendDb, _config, actorId, text) => ({
    target: "youtube_shorts",
    apply: (metadata, draftId) => {
      metadata.title = text;
      createStudioServices(_backendDb, _config).videos.rename(actorId, draftId, text || "YouTube Shorts");
    },
  }),
  youtube_description: (_backendDb, _config, _actorId, text) => ({
    target: "youtube_shorts",
    apply: (metadata) => {
      metadata.description = text === "-" ? "" : text;
    },
  }),
  youtube_game_url: (_backendDb, _config, _actorId, text) => ({
    target: "youtube_shorts",
    apply: (metadata) => {
      metadata.gameUrl = text === "-" ? undefined : fixUrlSlashes(text);
    },
  }),
  youtube_tags: (_backendDb, _config, _actorId, text) => ({
    target: "youtube_shorts",
    apply: (metadata) => {
      metadata.tags = advanceVideoMetadata("youtube_tags", text, {}).data.youtube_tags as string[];
    },
  }),
  instagram_caption: (_backendDb, _config, _actorId, text) => ({
    target: "instagram_reels",
    apply: (metadata) => {
      metadata.caption = text === "-" ? "" : text;
      delete metadata.hashtags;
    },
  }),
};

/** Isolates the one step that legitimately fails on bad user input. Any other
 * error in this flow (preview, delivery, storage) must reach the generic
 * describeError path instead of being misreported as an unparsable date. */
async function parseScheduleDate(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  text: string,
): Promise<Date> {
  return createStudioServices(backendDb, config).videos.parseSchedule(actorId, draftId, text);
}

async function handleScheduleMessage({ backendDb, config, actorId, session, text }: VideoMessageArgs): Promise<PublicationEffect[]> {
  if (session.draftId == null) throw new StudioError("err.video-missing");
  try {
    const date = await parseScheduleDate(backendDb, config, actorId, session.draftId, text);
    return applyVideoScheduleDate(backendDb, config, actorId, session, date);
  } catch (error) {
    const locale = botLocale(backendDb, actorId);
    const message =
      error instanceof StudioError && error.code === "common.schedule-parse-error"
        ? t(locale, "common.schedule-parse-error", { timezone: config.TIMEZONE_LABEL })
        : describeError(locale, error);
    return [videoPromptEffect(backendDb, actorId, message, true)];
  }
}

/** Applies one parsed/picked date to the current schedule step, whether it
 * came from free text or a slot button. Shared so the "different time per
 * platform" chain (schedule_target + data.target → next target) behaves identically
 * either way. */
async function applyVideoScheduleDate(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoConversationState,
  date: Date,
): Promise<PublicationEffect[]> {
  if (session.draftId == null) throw new StudioError("err.video-missing");
  const handler = SCHEDULE_DATE_HANDLERS[session.step as keyof typeof SCHEDULE_DATE_HANDLERS];
  if (!handler) throw new StudioError("err.video-reopen-publish");
  return handler({ backendDb, config, actorId, session, date });
}

type ScheduleDateArgs = {
  backendDb: BackendDb;
  config: BackendConfig;
  actorId: number;
  session: VideoConversationState;
  date: Date;
};

const SCHEDULE_DATE_HANDLERS: Record<"schedule_common" | "schedule_target", (args: ScheduleDateArgs) => Promise<PublicationEffect[]>> = {
  schedule_common: async ({ backendDb, config, actorId, session, date }) => {
    const transition = await acceptFlow(VIDEO_FLOW, "schedule_common", date.toISOString(), {
      ...session.data,
      selectedTargets: session.selected,
    });
    if (!transition?.next) throw new StudioError("err.video-reopen-publish");
    return confirmVideoSchedule(backendDb, config, actorId, session, commonVideoSchedule(session.selected, date));
  },
  schedule_target: applyIndividualScheduleDate,
};

async function applyIndividualScheduleDate({ backendDb, config, actorId, session, date }: ScheduleDateArgs): Promise<PublicationEffect[]> {
  const target =
    typeof session.data.target === "string" && VIDEO_TARGETS.includes(session.data.target as VideoTarget)
      ? (session.data.target as VideoTarget)
      : null;
  if (!target || !session.selected.includes(target)) throw new StudioError("err.video-reopen-publish");
  const transition = advanceVideoTargetSchedule(
    session.selected,
    (session.data.schedule as Record<string, string> | undefined) ?? {},
    target,
    date,
  );
  const flowTransition = await acceptFlow(VIDEO_FLOW, "schedule_target", date.toISOString(), {
    ...session.data,
    selectedTargets: session.selected,
    nextTarget: transition.nextTarget,
  });
  if (!flowTransition?.next) throw new StudioError("err.video-reopen-publish");
  if (flowTransition.next === "schedule_target") {
    const next: VideoConversationState = {
      ...session,
      step: flowTransition.next,
      data: { ...flowTransition.data, schedule: transition.schedule, target: transition.nextTarget },
    };
    const saved = saveVideoState(backendDb, actorId, next);
    return videoTimeEffects(
      backendDb,
      actorId,
      saved,
      t(botLocale(backendDb, actorId), "video.schedule-target-prompt", {
        target: videoTargetLabel(transition.nextTarget as VideoTarget),
        timezone: config.TIMEZONE_LABEL,
      }),
    );
  }
  return confirmVideoSchedule(
    backendDb,
    config,
    actorId,
    session,
    Object.fromEntries(Object.entries(transition.schedule).map(([key, value]) => [key, new Date(value)])) as Partial<
      Record<VideoTarget, Date>
    >,
  );
}

async function confirmVideoSchedule(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoConversationState,
  schedule: Partial<Record<VideoTarget, Date>>,
): Promise<PublicationEffect[]> {
  if (!session.draftId) throw new StudioError("err.video-missing");
  const locale = botLocale(backendDb, actorId);
  const next: VideoConversationState = {
    ...session,
    step: "schedule_confirm",
    data: {
      ...session.data,
      schedule: Object.fromEntries(Object.entries(schedule).map(([target, value]) => [target, value?.toISOString()])),
    },
  };
  const saved = saveVideoState(backendDb, actorId, next);
  const delivery = createStudioServices(backendDb, config).videos.preview(actorId, session.draftId).delivery;
  const lines = [`🎬 *${t(locale, "common.confirm-schedule")}*`];
  for (const target of next.selected) {
    const value = schedule[target];
    if (value)
      lines.push(
        `${videoTargetLabel(target)}: ${value.toLocaleString(locale === "ru" ? "ru-RU" : "en-GB", { timeZone: config.TIMEZONE })} ${config.TIMEZONE_LABEL}`,
      );
  }
  const keyboard = confirmationKeyboard(
    { label: t(locale, "common.confirm"), callback: publicationCallback("video", "schedule_confirm", [session.draftId ?? ""]) },
    { label: t(locale, "common.back"), callback: publicationCallback("video", "schedule", [session.draftId ?? ""]) },
    saved.revision,
  );
  return [
    { type: "delivery-previews", projections: delivery.projections, locale },
    ...videoControlEffects(saved, lines.join("\n"), keyboard),
  ];
}

async function finishSingleVideoEdit(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoConversationState,
  target: VideoTarget,
  change: (metadata: Record<string, unknown>, draftId: number) => void,
): Promise<PublicationEffect[]> {
  if (session.draftId == null) throw new StudioError("err.video-reopen-edit");
  const row = createStudioServices(backendDb, config)
    .videos.get(actorId, session.draftId)
    .targets.find((item) => item.target === target);
  const metadata = { ...(row?.metadataJson as Record<string, unknown> | undefined) };
  change(metadata, session.draftId);
  createStudioServices(backendDb, config).videos.updateMetadata(actorId, session.draftId, target, metadata as VideoMetadata);
  clearVideoState(backendDb, actorId);
  const locale = botLocale(backendDb, actorId);
  const preview = videoPreview(createStudioServices(backendDb, config).videos.preview(actorId, session.draftId), config, locale);
  return [
    {
      type: "screen",
      mode: "reply",
      text: preview.text,
      options: { parse_mode: "Markdown", reply_markup: preview.keyboard },
      card: { kind: "video", draftId: session.draftId },
    },
  ];
}
