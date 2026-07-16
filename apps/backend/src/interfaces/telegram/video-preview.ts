import { InlineKeyboard } from "grammy";
import { type BotLocale, ui } from "../../bot/i18n.js";
import type { BackendDb } from "../../db/client.js";
import { isVideoTargetEditable, isVideoTargetSchedulable } from "../../publishing/state.js";
import { getVideoDraft, listVideoTargets } from "../../publishing/video-data.js";
import type { InstagramMetadata, YouTubeMetadata } from "../../publishing/video-types.js";
import { formatVideoTime } from "./video-time.js";

/** Telegram-only representation of a video draft. The video domain itself
 * exposes data and operations, never grammY markup or interface language. */
export function videoPreview(
  backendDb: BackendDb,
  videoDraftId: number,
  locale: BotLocale = "ru",
): { text: string; keyboard: InlineKeyboard } {
  const draft = getVideoDraft(backendDb, videoDraftId);
  const targets = listVideoTargets(backendDb, videoDraftId);
  const title = draft.label || ui(locale, "Video publication", "Видеопубликация");
  const lines = [`🎬 *${escapeMarkdown(title)}*`, `${ui(locale, "Status", "Статус")}: *${videoStatusLabel(draft.status, locale)}*`];
  const keyboard = new InlineKeyboard();
  const ytTarget = targets.find((target) => target.target === "youtube_shorts");
  const igTarget = targets.find((target) => target.target === "instagram_reels");
  if (ytTarget) {
    const metadata = (ytTarget.metadataJson ?? {}) as Partial<YouTubeMetadata>;
    lines.push("", "▶️ *YouTube Shorts*", `${ui(locale, "Title", "Название")}: ${escapeMarkdown(metadata.title || "—")}`);
    if (metadata.description) lines.push(`${ui(locale, "Description", "Описание")}: ${escapeMarkdown(metadata.description)}`);
    if (metadata.gameUrl) lines.push(`${ui(locale, "Game", "Игра")}: ${escapeMarkdown(metadata.gameUrl)}`);
    if (metadata.tags?.length) lines.push(`${ui(locale, "Tags", "Теги")}: ${escapeMarkdown(metadata.tags.join(", "))}`);
    lines.push(
      `${ui(locale, "State", "Состояние")}: ${videoStatusLabel(ytTarget.status, locale)}${ytTarget.scheduledAt ? ` · ${formatVideoTime(ytTarget.scheduledAt, locale)}` : ""}`,
    );
    if (isVideoTargetSchedulable(ytTarget.status))
      keyboard.text(ui(locale, "🕒 YouTube time", "🕒 Время YouTube"), `video_time:youtube_shorts:${draft.id}`);
    if (isVideoTargetEditable(ytTarget.status))
      keyboard.text(ui(locale, "❌ Remove YouTube", "❌ Убрать YouTube"), `video_remove:youtube_shorts:${draft.id}`).row();
  }
  if (igTarget) {
    const metadata = (igTarget.metadataJson ?? {}) as Partial<InstagramMetadata>;
    lines.push("", "📸 *Instagram Reels*", `${ui(locale, "Description", "Описание")}: ${escapeMarkdown(metadata.caption || "—")}`);
    lines.push(
      `${ui(locale, "State", "Состояние")}: ${videoStatusLabel(igTarget.status, locale)}${igTarget.scheduledAt ? ` · ${formatVideoTime(igTarget.scheduledAt, locale)}` : ""}`,
    );
    if (isVideoTargetSchedulable(igTarget.status))
      keyboard.text(ui(locale, "🕒 Instagram time", "🕒 Время Instagram"), `video_time:instagram_reels:${draft.id}`);
    if (isVideoTargetEditable(igTarget.status))
      keyboard.text(ui(locale, "❌ Remove Instagram", "❌ Убрать Instagram"), `video_remove:instagram_reels:${draft.id}`).row();
    if (igTarget.status === "failed")
      keyboard.text(ui(locale, "🔁 Retry Instagram", "🔁 Повторить Instagram"), `video_retry:instagram_reels:${draft.id}`).row();
  }
  if (ytTarget?.status === "failed")
    keyboard.text(ui(locale, "🔁 Retry YouTube", "🔁 Повторить YouTube"), `video_retry:youtube_shorts:${draft.id}`).row();
  if (targets.length > 0 && (draft.status === "draft" || draft.status === "editing"))
    keyboard.text(ui(locale, "📅 Schedule", "📅 Запланировать"), `video_schedule:${draft.id}`).row();
  keyboard.text(ui(locale, "✏️ Edit details", "✏️ Изменить данные"), `video_edit_menu:${draft.id}`);
  keyboard.text(ui(locale, "🗑 Cancel publication", "🗑 Отменить публикацию"), `video_cancel:${draft.id}`).row();
  keyboard.text(ui(locale, "← Work queue", "← К очереди"), "queue_home");
  return { text: lines.join("\n"), keyboard };
}

function videoStatusLabel(status: string, locale: BotLocale): string {
  const labels: Record<string, string> = {
    editing: ui(locale, "editing", "заполняется"),
    draft: ui(locale, "draft", "черновик"),
    scheduled: ui(locale, "scheduled", "запланировано"),
    preparing: ui(locale, "preparing", "подготовка"),
    prepared: ui(locale, "ready to publish", "готово к публикации"),
    publishing: ui(locale, "publishing", "публикуется"),
    published: ui(locale, "published", "опубликовано"),
    failed: ui(locale, "failed", "ошибка"),
    cancelled: ui(locale, "cancelled", "отменено"),
  };
  return labels[status] ?? status;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([_*[\]`])/g, "\\$1");
}
