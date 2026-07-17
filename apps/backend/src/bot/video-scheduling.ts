import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { setTelegramVideoCard } from "../interfaces/telegram/control-cards.js";
import { t } from "../interfaces/telegram/i18n/index.js";
import { videoPreview } from "../interfaces/telegram/video-preview.js";
import type { VideoTarget } from "../publishing/video-types.js";
import { studioServices } from "../studio/services/index.js";
import { botLocale } from "./i18n.js";
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

async function showScheduledVideo(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  adminId: number,
  session: VideoSession,
  technical: { summary: string; warning: string | null },
  locale: "ru" | "en",
): Promise<void> {
  if (!session.draftId) throw new StudioError("err.video-missing");
  const preview = videoPreview(backendDb, session.draftId, locale);
  const text = `${technical.summary}${technical.warning ? `\n${technical.warning}` : ""}\n\n✅ ${t(locale, "common.scheduled")}. ${t(locale, "video.reminder", { minutes: config.VIDEO_REMINDER_MINUTES })}\n\n${preview.text}`;
  const controlMessageId = Number(session.data.controlMessageId);
  clearSession(backendDb, adminId);
  if (controlMessageId && ctx.chat?.id) {
    await ctx.api.editMessageText(ctx.chat.id, controlMessageId, `✅ ${t(locale, "video.confirmed-card")}`);
  }
  const message = await ctx.reply(text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
  if (ctx.chat?.id) setTelegramVideoCard(backendDb, session.draftId, Number(ctx.chat.id), message.message_id);
}
