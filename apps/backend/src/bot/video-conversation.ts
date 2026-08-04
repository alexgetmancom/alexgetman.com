import { type Context, InlineKeyboard } from "grammy";
import { fixUrlSlashes } from "../content/message.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { describeError, t } from "../foundation/i18n/index.js";
import { log } from "../foundation/logger.js";
import { setTelegramVideoCard } from "../interfaces/telegram/control-cards.js";
import { sendTelegramDeliveryPreviews } from "../interfaces/telegram/delivery-previews.js";
import { storeTelegramVideo } from "../interfaces/telegram/video-ingress.js";
import { videoPreview } from "../interfaces/telegram/video-preview.js";
import { VIDEO_TARGETS, type VideoMetadata, type VideoTarget, videoTargetLabel } from "../publishing/video-types.js";
import { createStudioServices } from "../studio/services/index.js";
import {
  acceptVideoFlowStep,
  advanceVideoMetadata,
  advanceVideoTargetSchedule,
  commonVideoSchedule,
  firstVideoMetadataStep,
  type VideoWizardStep,
} from "../studio/video-fsm.js";
import { appendCancelButton, confirmationKeyboard } from "./dialog-ui.js";
import { botLocale } from "./i18n.js";
import { publicationCallback } from "./session-fsm.js";
import {
  askInstagramOrSchedule,
  askSchedule,
  clearVideoState,
  enabledVideoTargets,
  getVideoState,
  replyVideoPrompt,
  saveVideoState,
  sendVideoControl,
  sendVideoMetadataPrompt,
  sendVideoTimePrompt,
  setVideoData,
  targetKeyboard,
  type VideoConversationState,
} from "./video-ui.js";

type VideoMessageArgs = {
  ctx: Context;
  backendDb: BackendDb;
  config: BackendConfig;
  actorId: number;
  session: VideoConversationState;
  text: string;
};
type VideoMessageHandler = (args: VideoMessageArgs) => Promise<boolean>;
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
  if (ctx.callbackQuery?.message) await ctx.editMessageText(text, { reply_markup: keyboard });
  else await ctx.reply(text, { reply_markup: keyboard });
}

export async function handleVideoConversationMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  if (!config.studio.modules.video_posting) return false;
  const actorId = Number(ctx.from?.id);
  const session = getVideoState(backendDb, actorId);
  if (!session) return false;
  const handler = VIDEO_MESSAGE_HANDLERS[session.step];
  if (!handler) return false;
  try {
    const text = ctx.message && "text" in ctx.message ? (ctx.message.text?.trim() ?? "") : "";
    if (handler.requiresText && !text) {
      const locale = botLocale(backendDb, actorId);
      await replyVideoPrompt(ctx, backendDb, actorId, locale, t(locale, "video.await-text"));
      return true;
    }
    const edit =
      session.data.is_single_edit && handler.requiresText ? singleEditChange(backendDb, config, actorId, session.step, text) : null;
    return edit
      ? finishSingleVideoEdit(ctx, backendDb, config, actorId, session, edit.target, edit.apply).then(() => true)
      : handler.handle({ ctx, backendDb, config, actorId, session, text });
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
    await replyVideoPrompt(ctx, backendDb, actorId, locale, `🔴 ${t(locale, "video.value-error")}: ${describeError(locale, error)}`, {
      plainText: true,
    });
    return true;
  }
}

async function handleAssetMessage({ ctx, backendDb, config, actorId, session }: VideoMessageArgs): Promise<boolean> {
  const stored = await storeTelegramVideo(ctx, backendDb, config, actorId);
  const draftId = createStudioServices(backendDb, config).publications.create(actorId, {
    kind: "video",
    studioMediaAssetId: stored.assetId,
    locale: session.data.videoLocale === "en" ? "en" : "ru",
  }).id;
  const selected = enabledVideoTargets(config);
  if (!selected.length) throw new StudioError("err.no-video-platforms-config");
  createStudioServices(backendDb, config).videos.replaceTargets(actorId, draftId, selected);
  const first = firstVideoMetadataStep(selected);
  const transition = await acceptVideoFlowStep("asset", stored.assetId, { ...session.data, selectedTargets: selected });
  if (!transition?.next) throw new StudioError("err.video-restart");
  const next: VideoConversationState = { ...session, draftId, step: first.step, selected, data: transition.data };
  saveVideoState(backendDb, actorId, next);
  await sendVideoMetadataPrompt(ctx, backendDb, actorId, first.step, selected);
  return true;
}

async function handleLabelMessage({ ctx, backendDb, config, actorId, session, text }: VideoMessageArgs): Promise<boolean> {
  if (session.draftId == null) return false;
  createStudioServices(backendDb, config).videos.rename(actorId, session.draftId, text);
  if (session.data.is_single_edit) {
    clearVideoState(backendDb, actorId);
    const locale = botLocale(backendDb, actorId);
    const preview = videoPreview(createStudioServices(backendDb, config).videos.preview(actorId, session.draftId), config, locale);
    await sendFreshVideoCard(ctx, backendDb, session.draftId, preview);
    return true;
  }
  const transition = await acceptVideoFlowStep("label", text, { ...session.data, selectedTargets: session.selected });
  if (!transition?.next) throw new StudioError("err.video-restart");
  const next: VideoConversationState = { ...session, step: transition.next as VideoConversationState["step"], data: transition.data };
  const saved = saveVideoState(backendDb, actorId, next);
  await sendVideoControl(
    ctx,
    backendDb,
    actorId,
    next,
    t(botLocale(backendDb, actorId), "video.choose-platforms-next"),
    targetKeyboard(config, saved.selected, botLocale(backendDb, actorId), saved.revision),
  );
  return true;
}

async function handleLinearMetadataMessage({ ctx, backendDb, actorId, session, text }: VideoMessageArgs): Promise<boolean> {
  if (session.draftId == null) return false;
  const step = session.step as VideoWizardStep;
  const transition = await acceptVideoFlowStep(step, text, { ...session.data, selectedTargets: session.selected });
  if (!transition?.next) throw new StudioError("err.video-restart");
  const data = withoutFlowData(transition.data);
  setVideoData(backendDb, actorId, session, step, data[step], transition.next as VideoConversationState["step"]);
  await sendVideoMetadataPrompt(ctx, backendDb, actorId, transition.next as VideoWizardStep, session.selected);
  return true;
}

async function handleYoutubeTagsMessage({ ctx, backendDb, config, actorId, session, text }: VideoMessageArgs): Promise<boolean> {
  if (session.draftId == null) return false;
  const transition = await acceptVideoFlowStep("youtube_tags", text, { ...session.data, selectedTargets: session.selected });
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
  await askInstagramOrSchedule(ctx, backendDb, config, actorId, saved);
  return true;
}

async function handleInstagramCaptionMessage({ ctx, backendDb, config, actorId, session, text }: VideoMessageArgs): Promise<boolean> {
  if (session.draftId == null) return false;
  const transition = await acceptVideoFlowStep("instagram_caption", text, { ...session.data, selectedTargets: session.selected });
  if (!transition) throw new StudioError("err.video-restart");
  const metadata = { caption: String(transition.data.instagram_caption ?? "") };
  createStudioServices(backendDb, config).videos.updateMetadata(actorId, session.draftId, "instagram_reels", metadata);
  if (!session.selected.includes("youtube_shorts"))
    createStudioServices(backendDb, config).videos.rename(actorId, session.draftId, metadata.caption || "Instagram Reels");
  const saved = saveVideoState(backendDb, actorId, { ...session, data: withoutFlowData(transition.data) });
  await askSchedule(ctx, backendDb, config, actorId, saved);
  return true;
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
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  text: string,
): Promise<Date | null> {
  try {
    return createStudioServices(backendDb, config).videos.parseSchedule(actorId, draftId, text);
  } catch (error) {
    const locale = botLocale(backendDb, actorId);
    const message =
      error instanceof StudioError && error.code === "common.schedule-parse-error"
        ? t(locale, "common.schedule-parse-error", { timezone: config.TIMEZONE_LABEL })
        : describeError(locale, error);
    await replyVideoPrompt(ctx, backendDb, actorId, locale, message, { plainText: true });
    return null;
  }
}

async function handleScheduleMessage({ ctx, backendDb, config, actorId, session, text }: VideoMessageArgs): Promise<boolean> {
  if (session.draftId == null) throw new StudioError("err.video-missing");
  const date = await parseScheduleDate(ctx, backendDb, config, actorId, session.draftId, text);
  if (!date) return true;
  await applyVideoScheduleDate(ctx, backendDb, config, actorId, session, date);
  return true;
}

/** Applies one parsed/picked date to the current schedule step, whether it
 * came from free text or a slot button. Shared so the "different time per
 * platform" chain (schedule_target + data.target → next target) behaves identically
 * either way. */
export async function applyVideoScheduleDate(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoConversationState,
  date: Date,
): Promise<void> {
  if (session.draftId == null) throw new StudioError("err.video-missing");
  const handler = SCHEDULE_DATE_HANDLERS[session.step as keyof typeof SCHEDULE_DATE_HANDLERS];
  if (!handler) throw new StudioError("err.video-reopen-publish");
  await handler({ ctx, backendDb, config, actorId, session, date });
}

type ScheduleDateArgs = {
  ctx: Context;
  backendDb: BackendDb;
  config: BackendConfig;
  actorId: number;
  session: VideoConversationState;
  date: Date;
};

const SCHEDULE_DATE_HANDLERS: Record<"schedule_common" | "schedule_target", (args: ScheduleDateArgs) => Promise<void>> = {
  schedule_common: async ({ ctx, backendDb, config, actorId, session, date }) => {
    const transition = await acceptVideoFlowStep("schedule_common", date.toISOString(), {
      ...session.data,
      selectedTargets: session.selected,
    });
    if (!transition?.next) throw new StudioError("err.video-reopen-publish");
    await confirmVideoSchedule(ctx, backendDb, config, actorId, session, commonVideoSchedule(session.selected, date));
  },
  schedule_target: applyIndividualScheduleDate,
};

async function applyIndividualScheduleDate({ ctx, backendDb, config, actorId, session, date }: ScheduleDateArgs): Promise<void> {
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
  const flowTransition = await acceptVideoFlowStep("schedule_target", date.toISOString(), {
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
    await sendVideoTimePrompt(
      ctx,
      backendDb,
      actorId,
      saved,
      t(botLocale(backendDb, actorId), "video.schedule-target-prompt", {
        target: videoTargetLabel(transition.nextTarget as VideoTarget),
        timezone: config.TIMEZONE_LABEL,
      }),
    );
    return;
  }
  await confirmVideoSchedule(
    ctx,
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
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoConversationState,
  schedule: Partial<Record<VideoTarget, Date>>,
): Promise<void> {
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
  await sendTelegramDeliveryPreviews(ctx, delivery.projections, botLocale(backendDb, actorId));
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
  await sendVideoControl(ctx, backendDb, actorId, saved, lines.join("\n"), keyboard);
}

async function finishSingleVideoEdit(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoConversationState,
  target: VideoTarget,
  change: (metadata: Record<string, unknown>, draftId: number) => void,
): Promise<void> {
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
  await sendFreshVideoCard(ctx, backendDb, session.draftId, preview);
}

/** A completed edit gets a fresh card at the bottom, same as post edits: the
 * previous card is history to scroll back to, never a moving prompt. */
async function sendFreshVideoCard(
  ctx: Context,
  backendDb: BackendDb,
  draftId: number,
  preview: { text: string; keyboard: InlineKeyboard },
): Promise<void> {
  const message = await ctx.reply(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
  if (ctx.chat?.id) setTelegramVideoCard(backendDb, draftId, Number(ctx.chat.id), message.message_id);
}
