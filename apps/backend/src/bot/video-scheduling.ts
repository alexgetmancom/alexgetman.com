import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { t } from "../foundation/i18n/index.js";
import { setTelegramVideoCard } from "../interfaces/telegram/control-cards.js";
import { videoPreview } from "../interfaces/telegram/video-preview.js";
import type { VideoTechnicalCheck } from "../publishing/video-service.js";
import type { VideoTarget } from "../publishing/video-types.js";
import { createStudioServices } from "../studio/services/index.js";
import { type BotLocale, botLocale } from "./i18n.js";
import { clearSession, type VideoSession } from "./video-session.js";

export async function finishVideoSchedule(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoSession,
  schedule: Partial<Record<VideoTarget, Date>>,
): Promise<void> {
  if (!session.draftId) throw new StudioError("err.video-missing");
  const locale = botLocale(backendDb, actorId);
  const technical = await createStudioServices(backendDb, config).videos.schedule(actorId, session.draftId, schedule);
  await showScheduledVideo(ctx, backendDb, config, actorId, session, technical, locale);
}

/** Telegram only renders the result; the immediate scheduling policy lives in Video Studio. */
export async function finishVideoNow(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoSession,
): Promise<void> {
  if (!session.draftId) throw new StudioError("err.video-missing");
  const locale = botLocale(backendDb, actorId);
  const technical = await createStudioServices(backendDb, config).videos.publish(actorId, session.draftId);
  await showScheduledVideo(ctx, backendDb, config, actorId, session, technical, locale);
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
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  session: VideoSession,
  technical: VideoTechnicalCheck,
  locale: BotLocale,
): Promise<void> {
  if (!session.draftId) throw new StudioError("err.video-missing");
  const preview = videoPreview(createStudioServices(backendDb, config).videos.preview(actorId, session.draftId), config, locale);
  const reminderMinutes = createStudioServices(backendDb, config).settings.notifications(actorId).reminderMinutes;
  const warning = technical.aspectOk ? "" : `\n${t(locale, "video.aspect-warning")}`;
  const text = `${videoCheckSummary(technical, locale)}${warning}\n\n✅ ${t(locale, "common.scheduled")}. ${t(locale, "video.reminder", { minutes: reminderMinutes })}\n\n${preview.text}`;
  const controlMessageId = session.controlMessageId;
  clearSession(backendDb, actorId);
  if (controlMessageId && ctx.chat?.id) {
    await ctx.api.editMessageText(ctx.chat.id, controlMessageId, `✅ ${t(locale, "video.confirmed-card")}`);
  }
  const message = await ctx.reply(text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
  if (ctx.chat?.id) setTelegramVideoCard(backendDb, session.draftId, Number(ctx.chat.id), message.message_id);
}
