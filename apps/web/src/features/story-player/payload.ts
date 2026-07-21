/* =============================================================================
 * ПОДГОТОВКА ДАННЫХ ДЛЯ ПЛЕЕРА (выполняется на сервере, при SSR)
 * -----------------------------------------------------------------------------
 * Вход:  HomePost[] — «сырые» посты из utils/home-posts.ts (уровень страницы).
 * Выход: PlayerPost[] — ровно те поля, которые нужны плееру, с готовыми
 *        абсолютными путями к медиа и вычисленными режимами ленты.
 *
 * Зачем отдельный слой: Svelte-остров получает эти данные как props и они
 * сериализуются в HTML. Всё, что можно посчитать заранее (параграфы, режимы,
 * форматирование просмотров), считаем ЗДЕСЬ, а не в браузере.
 *
 * Новое поле для плеера: добавь в PlayerPost + заполни в toPlayerPosts().
 * ========================================================================== */

import { metricValue, paragraphsFor } from "../../components/home-news/storyHelpers";
import type { HomeMedia, HomePost, HomeSource } from "../../components/home-news/types";

export interface PlayerPost {
  id: string;
  url: string;
  title: string;
  /** Параграфы для правой панели (обрезаны до 7, без дубля заголовка). */
  body: string[];
  /** Полный текст (для noscript-SEO и режима Deep). */
  fullBody: string[];
  excerpt: string;
  date: string;
  relativeDate: string;
  image: string | null;
  fallbackImage: string | null;
  posterSrc: string | null;
  mediaType: "image" | "video" | null;
  gallery: Array<{ type: "image" | "video"; path: string | null; poster: string | null }>;
  audioUrl: string | null;
  spotifyUrl: string | null;
  imageSrcSet: string;
  /** Отформатировано для показа: "1.2k". */
  views: string;
  category: string;
  sources: Array<{ url: string; label: string; official: boolean }>;
  /** В каких режимах ленты пост виден: latest / deep / watched. */
  feedModes: string[];
}

const publicSrc = (value?: string | null): string | null => (value ? `/${String(value).replace(/^\/+/, "")}` : null);

function fullTextFor(post: HomePost): string[] {
  return (post.body || post.excerpt || post.title)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Deep = длинные посты; Watched = топ по просмотрам (верхние ~8). */
function feedModesFor(post: HomePost, watchedCutoff: number): string[] {
  const text = fullTextFor(post).join(" ");
  const modes = ["latest"];
  if (text.length >= 700 || fullTextFor(post).length >= 4) modes.push("deep");
  if ((post.views || 0) >= watchedCutoff && watchedCutoff > 0) modes.push("watched");
  return modes;
}

export function toPlayerPosts(posts: HomePost[]): PlayerPost[] {
  const watchedCutoff = [...posts].map((post) => post.views || 0).sort((a, b) => b - a)[Math.min(7, Math.max(0, posts.length - 1))] || 0;
  return posts.map((post) => ({
    id: String(post.id),
    url: post.url,
    title: post.title,
    body: paragraphsFor(post),
    fullBody: fullTextFor(post),
    excerpt: post.excerpt,
    date: post.date,
    relativeDate: post.relativeDate,
    image: publicSrc(post.image),
    fallbackImage: publicSrc(post.fallbackImage),
    posterSrc: publicSrc(post.posterSrc),
    mediaType: post.mediaType || null,
    gallery: (post.gallery || []).map((media: HomeMedia) => ({
      type: media.type,
      path: publicSrc(media.path),
      poster: publicSrc(media.poster),
    })),
    audioUrl: post.audioUrl || null,
    spotifyUrl: post.spotifyUrl || null,
    imageSrcSet: post.imageSrcSet || "",
    views: metricValue(post.views),
    category: post.category,
    sources: (post.sources || []).map((source: HomeSource) => ({ ...source })),
    feedModes: feedModesFor(post, watchedCutoff),
  }));
}
