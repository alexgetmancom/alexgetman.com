import type { Context } from "grammy";
import { acceptFlow, flowStepInput } from "../application/conversation-flow.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { describeError, t } from "../foundation/i18n/index.js";
import { log } from "../foundation/logger.js";
import { storeTelegramVideo } from "../interfaces/telegram/video-ingress.js";
import type { VideoMetadata, VideoTarget } from "../publishing/video-types.js";
import { createStudioServices } from "../studio/services/index.js";
import { advanceVideoMetadata, VIDEO_FLOW, type VideoWizardStep } from "../studio/video-fsm.js";
import { executePublicationEffects, type PublicationEffect, type PublicationMessageResult } from "./effects.js";
import { botLocale } from "./i18n.js";
import { renderPublicationCard } from "./publication-card.js";
import { publicationCardEffect } from "./publication-card-effects.js";
import { applyVideoScheduleDate } from "./video-scheduling.js";
import {
  clearVideoState,
  enabledVideoTargets,
  getVideoState,
  saveVideoState,
  startVideoEffects,
  targetKeyboard,
  type VideoConversationState,
  type VideoConversationStep,
  videoControlEffects,
  videoPromptEffect,
  videoStepEffects,
} from "./video-ui.js";

type VideoMessageArgs = {
  ctx: Context;
  backendDb: BackendDb;
  config: BackendConfig;
  actorId: number;
  session: VideoConversationState;
  text: string;
};

/** Starts and advances the MP4 → metadata → schedule conversation. */
export async function startVideoConversation(ctx: Context, backendDb: BackendDb): Promise<void> {
  const actorId = Number(ctx.from?.id);
  const locale = botLocale(backendDb, actorId);
  // Reached via a menu button, this is pure navigation: turn that same
  // message into the prompt instead of leaving it and adding a new one.
  await executePublicationEffects(ctx, backendDb, startVideoEffects(ctx, backendDb, actorId, locale));
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
  // A step that expects nothing from the operator is driven by its own
  // controls, so an incoming message is not ours to consume.
  const input = flowStepInput(VIDEO_FLOW, session.step);
  if (!input) return { handled: false, effects: [] };
  try {
    const text = ctx.message && "text" in ctx.message ? (ctx.message.text?.trim() ?? "") : "";
    if (input === "text" && !text) {
      const locale = botLocale(backendDb, actorId);
      return { handled: true, effects: [videoPromptEffect(backendDb, actorId, t(locale, "video.await-text"))] };
    }
    const args = { ctx, backendDb, config, actorId, session, text };
    const singleEdit = session.data.is_single_edit && SINGLE_EDIT_FIELDS[session.step];
    return { handled: true, effects: singleEdit ? await finishSingleVideoEdit(args) : await acceptVideoMessage(args) };
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

/** Routes the message to the operation the current step performs. The wizard's
 * metadata steps are deliberately one case: they differ only in which field
 * they collect, and the flow already knows that. */
async function acceptVideoMessage(args: VideoMessageArgs): Promise<PublicationEffect[]> {
  const { step } = args.session;
  if (step === "asset") return acceptVideoAsset(args);
  if (step === "label") return acceptVideoLabel(args);
  if (step === "schedule_common" || step === "schedule_target") return acceptVideoScheduleDate(args);
  return acceptVideoMetadata(args);
}

async function acceptVideoAsset({ ctx, backendDb, config, actorId, session }: VideoMessageArgs): Promise<PublicationEffect[]> {
  const stored = await storeTelegramVideo(ctx, backendDb, config, actorId);
  const videos = createStudioServices(backendDb, config).videos;
  const draftId = videos.create(actorId, stored.assetId, session.data.videoLocale === "en" ? "en" : "ru");
  const selected = enabledVideoTargets(config);
  if (!selected.length) throw new StudioError("err.no-video-platforms-config");
  videos.replaceTargets(actorId, draftId, selected);
  const transition = await acceptFlow(VIDEO_FLOW, "asset", stored.assetId, { ...session.data, selectedTargets: selected });
  if (!transition?.next) throw new StudioError("err.video-restart");
  const next = transition.next as VideoConversationStep;
  const saved = saveVideoState(backendDb, actorId, { ...session, draftId, step: next, selected, data: transition.data });
  return videoStepEffects(backendDb, config, actorId, next, saved);
}

async function acceptVideoLabel({ backendDb, config, actorId, session, text }: VideoMessageArgs): Promise<PublicationEffect[]> {
  if (session.draftId == null) return [];
  createStudioServices(backendDb, config).videos.rename(actorId, session.draftId, text);
  if (session.data.is_single_edit) return videoCardEffects(backendDb, config, actorId, session.draftId);
  const transition = await acceptFlow(VIDEO_FLOW, "label", text, { ...session.data, selectedTargets: session.selected });
  if (!transition?.next) throw new StudioError("err.video-restart");
  const saved = saveVideoState(backendDb, actorId, { ...session, step: transition.next as VideoConversationStep, data: transition.data });
  const locale = botLocale(backendDb, actorId);
  return videoControlEffects(
    saved,
    t(locale, "video.choose-platforms-next"),
    targetKeyboard(config, saved.selected, locale, saved.revision),
  );
}

/** One case for every metadata field. A platform's collected fields are handed
 * to Video Studio the moment the flow leaves that platform's chain — the dialog
 * never decides what the metadata looks like or what the draft ends up called. */
async function acceptVideoMetadata({ backendDb, config, actorId, session, text }: VideoMessageArgs): Promise<PublicationEffect[]> {
  if (session.draftId == null) return [];
  const step = session.step as VideoWizardStep;
  const transition = await acceptFlow(VIDEO_FLOW, step, text, { ...session.data, selectedTargets: session.selected });
  if (!transition?.next) throw new StudioError("err.video-restart");
  const next = transition.next as VideoConversationStep;
  const data = withoutFlowData(transition.data);
  const completed = COMPLETED_WIZARD_TARGET[step];
  if (completed)
    createStudioServices(backendDb, config).videos.completeWizardTarget(actorId, session.draftId, completed, data, session.selected);
  const saved = saveVideoState(backendDb, actorId, { ...session, step: next, data });
  return videoStepEffects(backendDb, config, actorId, next, saved);
}

/** Isolates the one step that legitimately fails on bad user input. Any other
 * error in this flow (preview, delivery, storage) must reach the generic
 * describeError path instead of being misreported as an unparsable date. */
async function acceptVideoScheduleDate({ backendDb, config, actorId, session, text }: VideoMessageArgs): Promise<PublicationEffect[]> {
  if (session.draftId == null) throw new StudioError("err.video-missing");
  let date: Date;
  try {
    date = createStudioServices(backendDb, config).videos.manualSchedule(actorId, session.draftId, text);
  } catch (error) {
    const locale = botLocale(backendDb, actorId);
    const message =
      error instanceof StudioError && error.code === "common.schedule-parse-error"
        ? t(locale, "common.schedule-parse-error", { timezone: config.TIMEZONE_LABEL })
        : describeError(locale, error);
    return [videoPromptEffect(backendDb, actorId, message, true)];
  }
  return applyVideoScheduleDate(backendDb, config, actorId, session, date);
}

/** The last step of each platform's metadata chain, which is where that
 * platform's collected fields become its stored metadata. */
const COMPLETED_WIZARD_TARGET: Partial<Record<VideoWizardStep, VideoTarget>> = {
  youtube_tags: "youtube_shorts",
  instagram_caption: "instagram_reels",
};

function withoutFlowData(data: Record<string, unknown>): Record<string, unknown> {
  const { selectedTargets: _selectedTargets, ...persisted } = data;
  return persisted;
}

/** Which target one already-set field belongs to when it is edited outside the
 * wizard order (reached via "✏️ Edit" on a finished draft). The value itself is
 * parsed by the same transition the wizard uses, so "-" and URL fixing cannot
 * drift between the two entry points. */
const SINGLE_EDIT_FIELDS: Partial<Record<string, VideoTarget>> = {
  youtube_title: "youtube_shorts",
  youtube_description: "youtube_shorts",
  youtube_game_url: "youtube_shorts",
  youtube_tags: "youtube_shorts",
  instagram_caption: "instagram_reels",
};

async function finishSingleVideoEdit({ backendDb, config, actorId, session, text }: VideoMessageArgs): Promise<PublicationEffect[]> {
  if (session.draftId == null) throw new StudioError("err.video-reopen-edit");
  const step = session.step as VideoWizardStep;
  const target = SINGLE_EDIT_FIELDS[step];
  if (!target) throw new StudioError("err.video-reopen-edit");
  const videos = createStudioServices(backendDb, config).videos;
  const row = videos.get(actorId, session.draftId).targets.find((item) => item.target === target);
  const metadata = { ...(row?.metadataJson as Record<string, unknown> | undefined) };
  applySingleEdit(metadata, step, advanceVideoMetadata(step, text, {}).data[step]);
  videos.updateMetadata(actorId, session.draftId, target, metadata as VideoMetadata);
  if (step === "youtube_title") videos.rename(actorId, session.draftId, String(metadata.title ?? "") || "YouTube Shorts");
  return videoCardEffects(backendDb, config, actorId, session.draftId);
}

function applySingleEdit(metadata: Record<string, unknown>, step: VideoWizardStep, value: unknown): void {
  if (step === "youtube_title") metadata.title = value;
  if (step === "youtube_description") metadata.description = value;
  // An emptied URL is absent, not blank: the field is optional and a stored ""
  // would still render as a game link row on the card.
  if (step === "youtube_game_url") metadata.gameUrl = value ? value : undefined;
  if (step === "youtube_tags") metadata.tags = value;
  if (step === "instagram_caption") {
    metadata.caption = value;
    delete metadata.hashtags;
  }
}

/** Ends the dialog on the draft's own card. Both single-field edits and the
 * label edit finish this way: there is no next question to ask. */
function videoCardEffects(backendDb: BackendDb, config: BackendConfig, actorId: number, draftId: number): PublicationEffect[] {
  clearVideoState(backendDb, actorId);
  const preview = renderPublicationCard("video", {
    data: createStudioServices(backendDb, config).videos.preview(actorId, draftId),
    config,
    locale: botLocale(backendDb, actorId),
  });
  return publicationCardEffect("video", draftId, preview, { mode: "reply" });
}
