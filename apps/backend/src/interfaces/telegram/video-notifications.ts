import { eq } from "drizzle-orm";
import { type Bot, InlineKeyboard } from "grammy";
import type { BackendDb } from "../../db/client.js";
import { videoDrafts, videoTargets } from "../../db/schema.js";
import { getVideoDraft } from "../../publishing/video-data.js";
import type { VideoTarget } from "../../publishing/video-types.js";
import { videoTargetLabel } from "../../publishing/video-types.js";
import { telegramVideoCard } from "./control-cards.js";
import { videoPreview } from "./video-preview.js";
import { formatVideoTime } from "./video-time.js";

export async function notifyFinalVideoFailure(
  backendDb: BackendDb,
  bot: Bot | null,
  videoDraftId: number,
  videoTargetId: number | null,
): Promise<void> {
  if (!bot || !videoTargetId) return;
  const target = backendDb.db.select().from(videoTargets).where(eq(videoTargets.id, videoTargetId)).get();
  if (target?.status !== "failed") return;
  const draft = getVideoDraft(backendDb, videoDraftId);
  const targetName = target.target as VideoTarget;
  await bot.api.sendMessage(
    draft.adminId,
    `🔴 ${videoTargetLabel(targetName)} не опубликовал ролик «${draft.label || "Без названия"}».\n\n${target.lastError || "Неизвестная ошибка"}`,
    {
      reply_markup: new InlineKeyboard().text(
        `🔁 Повторить ${targetName === "youtube_shorts" ? "YouTube" : "Instagram"}`,
        `video_retry:${targetName}:${draft.id}`,
      ),
    },
  );
}

export async function refreshVideoControlCard(backendDb: BackendDb, bot: Bot | null, videoDraftId: number): Promise<void> {
  if (!bot) return;
  const card = telegramVideoCard(backendDb, videoDraftId);
  if (!card || card.chatId == null || card.messageId == null) return;
  const preview = videoPreview(backendDb, videoDraftId);
  try {
    await bot.api.editMessageText(card.chatId, card.messageId, preview.text, {
      parse_mode: "Markdown",
      reply_markup: preview.keyboard,
    });
  } catch {
    // A deleted or manually edited Telegram message must not stop publication.
  }
}

export async function sendVideoReminder(
  backendDb: BackendDb,
  bot: Bot | null,
  videoDraftId: number,
  videoTargetId: number | null,
  reminderMinutes: number,
): Promise<void> {
  const draft = getVideoDraft(backendDb, videoDraftId);
  const target = videoTargetId == null ? null : backendDb.db.select().from(videoTargets).where(eq(videoTargets.id, videoTargetId)).get();
  if (!bot || !target || draft.status !== "scheduled") return;
  const text = `⏰ Через ${reminderMinutes} мин. публикация:\n\n🎬 ${draft.label || "Без названия"}\n• ${videoTargetLabel(target.target as VideoTarget)}\n\n${formatVideoTime(target.scheduledAt)}`;
  await bot.api.sendMessage(draft.adminId, text, {
    reply_markup: new InlineKeyboard().text("Открыть", `video_open:${draft.id}`).text("Отменить", `video_cancel:${draft.id}`),
  });
  backendDb.db
    .update(videoDrafts)
    .set({ reminderSentAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(eq(videoDrafts.id, draft.id))
    .run();
}
