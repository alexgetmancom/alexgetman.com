import { acceptFlow } from "../application/conversation-flow.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { t } from "../foundation/i18n/index.js";
import type { VideoTechnicalCheck } from "../publishing/video-service.js";
import type { VideoTarget } from "../publishing/video-types.js";
import { createStudioServices } from "../studio/services/index.js";
import { currentSchedule, VIDEO_FLOW, videoScheduleDates } from "../studio/video-fsm.js";
import type { PublicationEffect } from "./effects.js";
import { type BotLocale, botLocale } from "./i18n.js";
import { renderPublicationCard } from "./publication-card.js";
import {
  clearVideoState,
  saveVideoState,
  type VideoConversationState,
  videoScheduleConfirmationEffects,
  videoStepEffects,
} from "./video-ui.js";

/** Applies one chosen time to whichever scheduling step the session is on. The
 * schedule can be completed from either transport — slot buttons or a typed
 * date — and both must advance identically, so the flow decides what comes
 * next and neither caller recomputes the remaining platforms. */
export async function applyVideoScheduleDate(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoConversationState,
  date: Date,
): Promise<PublicationEffect[]> {
  if (session.draftId == null) throw new StudioError("err.video-missing");
  const transition = await acceptFlow(VIDEO_FLOW, session.step, date.toISOString(), {
    ...session.data,
    selectedTargets: session.selected,
  });
  if (!transition?.next) throw new StudioError("err.video-reopen-publish");
  if (transition.next === "schedule_target") {
    const saved = saveVideoState(backendDb, actorId, { ...session, step: "schedule_target", data: transition.data });
    return videoStepEffects(backendDb, config, actorId, "schedule_target", saved);
  }
  return videoScheduleConfirmationEffects(backendDb, config, actorId, session, videoScheduleDates(currentSchedule(transition.data)));
}

export async function finishVideoSchedule(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoConversationState,
  schedule: Partial<Record<VideoTarget, Date>>,
): Promise<PublicationEffect[]> {
  if (!session.draftId) throw new StudioError("err.video-missing");
  const locale = botLocale(backendDb, actorId);
  const technical = await createStudioServices(backendDb, config).videos.schedule(actorId, session.draftId, schedule);
  return showScheduledVideo(backendDb, config, actorId, session, technical, locale);
}

/** Telegram only renders the result; the immediate scheduling policy lives in Video Studio. */
export async function finishVideoNow(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoConversationState,
): Promise<PublicationEffect[]> {
  if (!session.draftId) throw new StudioError("err.video-missing");
  const locale = botLocale(backendDb, actorId);
  const technical = await createStudioServices(backendDb, config).videos.publish(actorId, session.draftId);
  return showScheduledVideo(backendDb, config, actorId, session, technical, locale);
}

/** Formats the transport-neutral technical check into a Telegram summary line. */
function videoCheckSummary(technical: VideoTechnicalCheck, locale: BotLocale): string {
  const mm = String(Math.floor(technical.seconds / 60)).padStart(2, "0");
  const ss = String(technical.seconds % 60).padStart(2, "0");
  const audioCodec = technical.audioCodec ?? t(locale, "video.no-audio");
  return t(locale, "video.check-summary", {
    dims: `${technical.width}×${technical.height}`,
    dur: `${mm}:${ss}`,
    codecs: `${technical.videoCodec.toUpperCase()}/${audioCodec.toUpperCase()}`,
    sound: technical.audioCodec ? t(locale, "video.has-audio") : t(locale, "video.no-audio"),
    fps: technical.fps ? `${technical.fps.toFixed(0)} FPS` : t(locale, "video.fps-unknown"),
    mb: Math.ceil(technical.sizeBytes / 1024 / 1024),
  });
}

async function showScheduledVideo(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoConversationState,
  technical: VideoTechnicalCheck,
  locale: BotLocale,
): Promise<PublicationEffect[]> {
  if (!session.draftId) throw new StudioError("err.video-missing");
  const preview = renderPublicationCard("video", {
    data: createStudioServices(backendDb, config).videos.preview(actorId, session.draftId),
    config,
    locale,
  });
  const reminderMinutes = createStudioServices(backendDb, config).settings.notifications(actorId).reminderMinutes;
  const warning = technical.aspectOk ? "" : `\n${t(locale, "video.aspect-warning")}`;
  const text = `${videoCheckSummary(technical, locale)}${warning}\n\n✅ ${t(locale, "common.scheduled")}. ${t(locale, "video.reminder", { minutes: reminderMinutes })}\n\n${preview.text}`;
  clearVideoState(backendDb, actorId);
  return [
    { type: "screen", mode: "edit", text: `✅ ${t(locale, "video.confirmed-card")}` },
    {
      type: "prompt",
      text,
      options: { parse_mode: "Markdown", reply_markup: preview.keyboard },
      card: { kind: "video", draftId: session.draftId },
    },
  ];
}
