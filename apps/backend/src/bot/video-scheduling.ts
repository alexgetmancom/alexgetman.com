import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { videoPreview } from "../interfaces/telegram/video-preview.js";
import type { VideoTarget } from "../publishing/video-types.js";
import { studioServices } from "../studio/services/index.js";
import { botLocale, ui } from "./i18n.js";
import { clearSession, type VideoSession } from "./video-session.js";

export async function finishVideoSchedule(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  adminId: number,
  session: VideoSession,
  schedule: Partial<Record<VideoTarget, Date>>,
): Promise<void> {
  if (!session.draftId) throw new Error("Video draft is missing.");
  const locale = botLocale(backendDb, adminId);
  const technical = await studioServices(backendDb, config).videos.schedule(adminId, session.draftId, schedule);
  const preview = videoPreview(backendDb, session.draftId, locale);
  const text = `${technical.summary}${technical.warning ? `\n${technical.warning}` : ""}\n\n✅ ${ui(locale, "Scheduled", "Запланировано")}. ${ui(locale, `I will remind you ${config.VIDEO_REMINDER_MINUTES} minutes beforehand.`, `Напомню за ${config.VIDEO_REMINDER_MINUTES} минут.`)}\n\n${preview.text}`;
  const controlMessageId = Number(session.data.controlMessageId);
  clearSession(backendDb, adminId);
  if (controlMessageId && ctx.chat?.id) {
    await ctx.api.editMessageText(ctx.chat.id, controlMessageId, text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
    studioServices(backendDb, config).videos.setControlCard(adminId, session.draftId, Number(ctx.chat.id), controlMessageId);
    return;
  }
  const message = await ctx.reply(text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
  if (ctx.chat?.id)
    studioServices(backendDb, config).videos.setControlCard(adminId, session.draftId, Number(ctx.chat.id), message.message_id);
}
