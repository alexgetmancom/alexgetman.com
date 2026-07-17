import { eq } from "drizzle-orm";
import type { BackendDb } from "../../db/client.js";
import { creatorProfiles, socialComments } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { type StudioLocale as BotLocale, localize as ui } from "../../foundation/locale.js";
import { latestVideoMetrics, siteTotal, sum, textTotals, type VideoMetricRow } from "../metric-deltas.js";
import { metricNumber } from "../snapshots/creator-store.js";

export function creatorDashboard(
  backendDb: BackendDb,
  config: BackendConfig,
  days: number,
  locale: BotLocale = "ru",
): { text: string; hasComments: boolean } {
  const hasComments = backendDb.db.select({ id: socialComments.commentId }).from(socialComments).limit(1).get() != null;
  if (days === 0) return overallDashboard(backendDb, config, hasComments, locale);
  const since = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
  const latest = latestVideoMetrics(backendDb, since);
  const period = days === 1 ? ui(locale, "today", "сегодня") : ui(locale, `${days} days`, `${days} дней`);
  const lines = [`📊 *${ui(locale, `Statistics for ${period}`, `Статистика за ${period}`)}*`];
  if (config.studio.modules.site)
    lines.push(`🌐 ${ui(locale, "Site", "Сайт")}: ${siteTotal(backendDb, since)} ${ui(locale, "material views", "просмотров материалов")}`);
  if (config.studio.modules.text_posting) {
    const text = textTotals(backendDb, since);
    lines.push(
      `📝 ${ui(locale, "Posts", "Посты")}: ${text.views} ${ui(locale, "views", "просмотров")} · ${text.interactions} ${ui(locale, "interactions", "реакций")}`,
    );
  }
  if (config.studio.modules.video_posting) appendVideoDashboard(lines, latest, backendDb, config, locale);
  lines.push(
    `\n${ui(locale, "Data refreshes at most once a day to protect platform APIs.", "Данные обновляются не чаще раза в сутки — это бережно к API платформ.")}`,
  );
  return { text: lines.join("\n"), hasComments };
}

function overallDashboard(
  backendDb: BackendDb,
  config: BackendConfig,
  hasComments: boolean,
  locale: BotLocale,
): { text: string; hasComments: boolean } {
  const lines = [`🌐 *${ui(locale, "Overall statistics", "Общая статистика")}*`];
  if (config.studio.modules.site)
    lines.push(
      `\n🌐 ${ui(locale, "Site", "Сайт")}: ${siteTotal(backendDb, "0000-01-01T00:00:00.000Z")} ${ui(locale, "material views", "просмотров материалов")}`,
    );
  if (config.studio.modules.text_posting) {
    const text = textTotals(backendDb, "0000-01-01T00:00:00.000Z");
    lines.push(
      `📝 ${ui(locale, "Posts", "Посты")}: ${text.views} ${ui(locale, "views", "просмотров")} · ${text.interactions} ${ui(locale, "interactions", "реакций")}`,
    );
  }
  if (config.studio.modules.youtube) {
    const profileData = profile(backendDb, "youtube");
    lines.push("\n🔴 *YouTube (Канал):*");
    if (!profileData) lines.push("• Данные канала еще не синхронизированы.");
    else {
      const gained = metricNumber(profileData.subscribersGained);
      const lost = metricNumber(profileData.subscribersLost);
      lines.push(
        `• Подписчиков: ${metricNumber(profileData.subscriberCount)}`,
        `• Просмотров за все время: ${metricNumber(profileData.viewCount)}`,
        `• Всего видео: ${metricNumber(profileData.videoCount)}`,
        "• За последние 30 дней:",
        `  - Просмотры: ${metricNumber(profileData.views)}`,
        `  - Время просмотра: ${(metricNumber(profileData.estimatedMinutesWatched) / 60).toFixed(1)} ч.`,
        `  - Подписчики: +${gained} / -${lost} (прирост: ${gained - lost})`,
      );
    }
  }
  if (config.studio.modules.instagram) {
    const profileData = profile(backendDb, "instagram");
    lines.push("\n📸 *Instagram (Профиль):*");
    if (!profileData) lines.push("• Данные профиля еще не синхронизированы.");
    else
      lines.push(
        `• Подписчиков: ${metricNumber(profileData.followersCount)}`,
        `• Всего Reels/публикаций: ${metricNumber(profileData.mediaCount)}`,
      );
  }
  lines.push(
    `\n${ui(locale, "Data refreshes at most once a day to protect platform APIs.", "Данные обновляются не чаще раза в сутки — это бережно к API платформ.")}`,
  );
  return { text: lines.join("\n"), hasComments };
}

function appendVideoDashboard(
  lines: string[],
  latest: VideoMetricRow[],
  backendDb: BackendDb,
  config: BackendConfig,
  locale: BotLocale,
): void {
  const youtube = latest.filter((row) => row.platform === "youtube_shorts");
  const instagram = latest.filter((row) => row.platform === "instagram_reels");
  const all = [...youtube, ...instagram];
  lines.push(
    `🎬 ${ui(locale, "Videos", "Видео")}: ${sum(all, "views")} ${ui(locale, "views", "просмотров")} · ${sum(all, "likes") + sum(all, "comments")} ${ui(locale, "interactions", "взаимодействий")}`,
  );
  if (config.studio.modules.youtube) {
    const data = profile(backendDb, "youtube");
    lines.push(
      `YouTube: ${sum(youtube, "views")} просмотров · ${sum(youtube, "likes")} лайков${data ? ` · ${metricNumber(data.subscriberCount)} подписчиков` : ""}`,
    );
  }
  if (config.studio.modules.instagram) {
    const data = profile(backendDb, "instagram");
    lines.push(
      `Instagram: ${sum(instagram, "views")} просмотров · ${sum(instagram, "likes")} лайков · ${sum(instagram, "comments")} комментариев${data ? ` · ${metricNumber(data.followersCount)} подписчиков` : ""}`,
    );
  }
  const grouped: Record<string, { views: number; likes: number; comments: number }> = {};
  for (const row of latest) {
    const label = row.label || "Без названия";
    const item = grouped[label] ?? { views: 0, likes: 0, comments: 0 };
    item.views += metricNumber(row.metrics.views);
    item.likes += metricNumber(row.metrics.likes);
    item.comments += metricNumber(row.metrics.comments);
    grouped[label] = item;
  }
  const top = Object.entries(grouped)
    .map(([label, metrics]) => ({ label, ...metrics }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 3);
  if (top.length) {
    lines.push("\n🏆 *Топ публикаций (суммарно)*");
    for (const item of top) lines.push(`• ${item.label} — ${metricNumber(item.views)} просмотров · ${item.likes} 👍 · ${item.comments} 💬`);
  }
}

function profile(backendDb: BackendDb, platform: string): Record<string, unknown> | null {
  return backendDb.db.select().from(creatorProfiles).where(eq(creatorProfiles.platform, platform)).get()?.dataJson ?? null;
}
