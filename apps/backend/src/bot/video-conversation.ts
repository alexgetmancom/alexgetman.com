import type { Context } from "grammy";
import { flowStepInput } from "../application/conversation-flow.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { describeError, t } from "../foundation/i18n/index.js";
import { log } from "../foundation/logger.js";
import { storeTelegramVideo } from "../interfaces/telegram/video-ingress.js";
import type { VideoTarget } from "../publishing/video-types.js";
import type { StudioServices } from "../studio/services/index.js";
import { createStudioServices } from "../studio/services/index.js";
import { advanceVideoMetadata, isVideoWizardStep, VIDEO_FLOW, type VideoWizardStep } from "../studio/video-fsm.js";
import { executePublicationEffects, type PublicationEffect, type PublicationMessageResult } from "./effects.js";
import { botLocale } from "./i18n.js";
import { advancePublicationFlow } from "./publication-flow.js";
import { publicationCardEffect, publicationRenderers } from "./publication-renderers.js";
import { applyVideoScheduleDate } from "./video-scheduling.js";
import {
  clearVideoState,
  enabledVideoTargets,
  getVideoState,
  startVideoEffects,
  targetKeyboard,
  type VideoConversationState,
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
  services: StudioServices;
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
    const services = createStudioServices(backendDb, config);
    const singleEdit = session.data.is_single_edit && isVideoWizardStep(session.step);
    return {
      handled: true,
      effects: singleEdit ? await finishSingleVideoEdit({ ...args, services }) : await acceptVideoMessage({ ...args, services }),
    };
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
  if (!isVideoWizardStep(step)) throw new StudioError("err.video-restart");
  return acceptVideoMetadata(args);
}

async function acceptVideoAsset({ ctx, backendDb, config, actorId, session, services }: VideoMessageArgs): Promise<PublicationEffect[]> {
  // Nothing about this depends on the upload, so fail before spending a
  // Telegram download and before a draft row exists to be orphaned.
  const selected = enabledVideoTargets(config);
  if (!selected.length) throw new StudioError("err.no-video-platforms-config");
  const stored = await storeTelegramVideo(ctx, backendDb, config, actorId);
  const videos = services.videos;
  const draftId = videos.create(actorId, stored.assetId, session.data.videoLocale === "en" ? "en" : "ru");
  videos.replaceTargets(actorId, draftId, selected);
  const saved = await advancePublicationFlow(
    backendDb,
    actorId,
    VIDEO_FLOW,
    { ...session, draftId, selected },
    stored.assetId,
    { ...session.data, selectedTargets: selected },
    "err.video-restart",
  );
  return videoStepEffects(backendDb, config, actorId, saved);
}

async function acceptVideoLabel({ backendDb, config, actorId, session, text, services }: VideoMessageArgs): Promise<PublicationEffect[]> {
  if (session.draftId == null) throw new StudioError("err.video-missing");
  services.videos.rename(actorId, session.draftId, text);
  if (session.data.is_single_edit) return videoCardEffects(backendDb, config, actorId, session.draftId, services);
  const saved = await advancePublicationFlow(
    backendDb,
    actorId,
    VIDEO_FLOW,
    session,
    text,
    { ...session.data, selectedTargets: session.selected },
    "err.video-restart",
  );
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
async function acceptVideoMetadata({
  backendDb,
  config,
  actorId,
  session,
  text,
  services,
}: VideoMessageArgs): Promise<PublicationEffect[]> {
  if (session.draftId == null) throw new StudioError("err.video-missing");
  if (!isVideoWizardStep(session.step)) throw new StudioError("err.video-restart");
  const step = session.step;
  const saved = await advancePublicationFlow(
    backendDb,
    actorId,
    VIDEO_FLOW,
    session,
    text,
    { ...session.data, selectedTargets: session.selected },
    "err.video-restart",
  );
  const completed = COMPLETED_WIZARD_TARGET[step];
  if (completed) services.videos.completeWizardTarget(actorId, session.draftId, completed, saved.data, session.selected);
  return videoStepEffects(backendDb, config, actorId, saved);
}

/** Isolates the one step that legitimately fails on bad user input. Any other
 * error in this flow (preview, delivery, storage) must reach the generic
 * describeError path instead of being misreported as an unparsable date. */
async function acceptVideoScheduleDate({
  backendDb,
  config,
  actorId,
  session,
  text,
  services,
}: VideoMessageArgs): Promise<PublicationEffect[]> {
  if (session.draftId == null) throw new StudioError("err.video-missing");
  let date: Date;
  try {
    date = services.videos.manualSchedule(actorId, session.draftId, text);
  } catch (error) {
    const locale = botLocale(backendDb, actorId);
    const timeConfig = services.settings.timeConfig(actorId, config);
    const message =
      error instanceof StudioError && error.code === "common.schedule-parse-error"
        ? t(locale, "common.schedule-parse-error", { timezone: timeConfig.TIMEZONE_LABEL })
        : describeError(locale, error);
    return [videoPromptEffect(backendDb, actorId, message, true)];
  }
  return applyVideoScheduleDate(backendDb, config, actorId, session, date, services);
}

/** The last step of each platform's metadata chain, which is where that
 * platform's collected fields become its stored metadata. */
const COMPLETED_WIZARD_TARGET: Partial<Record<VideoWizardStep, VideoTarget>> = {
  youtube_tags: "youtube_shorts",
  instagram_caption: "instagram_reels",
};

/** Applies one already-set field edited outside the wizard order (reached via
 * "✏️ Edit" on a finished draft). The value is parsed by the same transition the
 * wizard uses, so "-" and URL fixing cannot drift between the two entry points. */
async function finishSingleVideoEdit({
  backendDb,
  config,
  actorId,
  session,
  text,
  services,
}: VideoMessageArgs): Promise<PublicationEffect[]> {
  if (session.draftId == null) throw new StudioError("err.video-reopen-edit");
  if (!isVideoWizardStep(session.step)) throw new StudioError("err.video-reopen-edit");
  const step = session.step;
  const videos = services.videos;
  const parsed = advanceVideoMetadata(step, text, {})[step];
  videos.editMetadataField(actorId, session.draftId, step, parsed);
  return videoCardEffects(backendDb, config, actorId, session.draftId, services);
}

/** Ends the dialog on the draft's own card. Both single-field edits and the
 * label edit finish this way: there is no next question to ask. */
function videoCardEffects(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  services: StudioServices,
): PublicationEffect[] {
  clearVideoState(backendDb, actorId);
  const preview = publicationRenderers(backendDb, config, services).video.card({
    backendDb,
    pipeline: services.videos,
    actorId,
    publicationId: draftId,
    config,
    locale: botLocale(backendDb, actorId),
  });
  return publicationCardEffect(preview, { mode: "reply" });
}
