import type { Context } from "grammy";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { listVideoTargets, scheduleVideo, setVideoControlCard, validateVideoDraft, videoPreview } from "../video/service.js";
import type { VideoTarget } from "../video/types.js";
import { clearSession, type VideoSession } from "./video-session.js";

export async function finishVideoSchedule(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  adminId: number,
  session: VideoSession,
  schedule: Partial<Record<VideoTarget, Date>>,
): Promise<void> {
  if (!session.draftId) throw new Error("Черновик не найден.");
  const technical = await validateVideoDraft(config, backendDb, session.draftId);
  const fullSchedule = { ...schedule };
  for (const target of listVideoTargets(backendDb, session.draftId)) {
    const key = target.target as VideoTarget;
    if (!fullSchedule[key]) fullSchedule[key] = target.scheduledAt ? new Date(target.scheduledAt) : new Date(Date.now() + 60_000);
  }
  scheduleVideo(backendDb, session.draftId, fullSchedule, {
    prepareLeadMinutes: config.VIDEO_PREPARE_LEAD_MINUTES,
    reminderMinutes: config.VIDEO_REMINDER_MINUTES,
  });
  clearSession(backendDb, adminId);
  const preview = videoPreview(backendDb, session.draftId);
  const message = await ctx.reply(
    `${technical.summary}${technical.warning ? `\n${technical.warning}` : ""}\n\n✅ Запланировано. Напомню за ${config.VIDEO_REMINDER_MINUTES} минут.\n\n${preview.text}`,
    {
      parse_mode: "Markdown",
      reply_markup: preview.keyboard,
    },
  );
  if (ctx.chat?.id) setVideoControlCard(backendDb, session.draftId, Number(ctx.chat.id), message.message_id);
}
