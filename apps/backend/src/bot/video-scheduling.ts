import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { setTelegramVideoCard } from "../interfaces/telegram/control-cards.js";
import { t } from "../interfaces/telegram/i18n/index.js";
import { videoPreview } from "../interfaces/telegram/video-preview.js";
import type { VideoTechnicalCheck } from "../publishing/video-service.js";
import type { VideoTarget } from "../publishing/video-types.js";
import { studioServices } from "../studio/services/index.js";
import { type BotLocale, botLocale } from "./i18n.js";
import { clearSession, type VideoSession } from "./video-session.js";

export async function finishVideoSchedule(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  adminId: number,
  session: VideoSession,
  schedule: Partial<Record<VideoTarget, Date>>,
): Promise<void> {
  if (!session.draftId) throw new StudioError("err.video-missing");
  const locale = botLocale(backendDb, adminId);
  const technical = await studioServices(backendDb, config).videos.schedule(adminId, session.draftId, schedule);
  await showScheduledVideo(ctx, backendDb, config, adminId, session, technical, locale);
}

/** Telegram only renders the result; the immediate scheduling policy lives in Video Studio. */
export async function finishVideoNow(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  adminId: number,
  session: VideoSession,
): Promise<void> {
  if (!session.draftId) throw new StudioError("err.video-missing");
  const locale = botLocale(backendDb, adminId);
  const technical = await studioServices(backendDb, config).videos.publish(adminId, session.draftId);
  await showScheduledVideo(ctx, backendDb, config, adminId, session, technical, locale);
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
  adminId: number,
  session: VideoSession,
  technical: VideoTechnicalCheck,
  locale: BotLocale,
): Promise<void> {
  if (!session.draftId) throw new StudioError("err.video-missing");
  const preview = videoPreview(backendDb, session.draftId, locale);
  const warning = technical.aspectOk ? "" : `\n${t(locale, "video.aspect-warning")}`;
  const text = `${videoCheckSummary(technical, locale)}${warning}\n\n✅ ${t(locale, "common.scheduled")}. ${t(locale, "video.reminder", { minutes: config.VIDEO_REMINDER_MINUTES })}\n\n${preview.text}`;
  const controlMessageId = Number(session.data.controlMessageId);
  clearSession(backendDb, adminId);
  if (controlMessageId && ctx.chat?.id) {
    await ctx.api.editMessageText(ctx.chat.id, controlMessageId, `✅ ${t(locale, "video.confirmed-card")}`);
  }
  const message = await ctx.reply(text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
  if (ctx.chat?.id) setTelegramVideoCard(backendDb, session.draftId, Number(ctx.chat.id), message.message_id);
}
