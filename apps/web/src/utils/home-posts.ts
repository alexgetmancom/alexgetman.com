import fs from "node:fs";
import path from "node:path";
import type { HomePost } from "../components/home-news/types";
import {
  categoryLabel,
  categorySlugFromBadge,
  excerptAfterTitle,
  formatRelativeTime,
  getFirstSentence,
  getSmartBadge,
  postImagePath,
  postOgImagePath,
  postVisualMedia,
} from "./helpers";

const WEB_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const PUBLIC_ROOT = path.join(WEB_ROOT, "public");

export function existingSiteImage(publicPath: string | null | undefined) {
  if (!publicPath) return null;
  const normalizedPath = String(publicPath).replace(/^\/+/, "");
  const candidates = [
    ...(process.env.SITE_PUBLIC_DIR ? [path.join(process.env.SITE_PUBLIC_DIR, normalizedPath)] : []),
    path.join(PUBLIC_ROOT, normalizedPath),
    path.resolve(process.cwd(), "public", normalizedPath),
    path.resolve(process.cwd(), "apps/web/public", normalizedPath),
  ];
  return candidates.some((candidate) => fs.existsSync(candidate)) ? normalizedPath : null;
}

export function responsiveSrcSetFor(publicPath: string | null | undefined) {
  if (!publicPath || !/\.(png|jpe?g)$/i.test(publicPath)) return undefined;
  const normalizedPath = String(publicPath).replace(/^\/+/, "");
  const publicFile = path.join(PUBLIC_ROOT, normalizedPath);
  if (!fs.existsSync(publicFile)) return undefined;
  const base = normalizedPath
    .replace(/^\/+/, "")
    .replace(/[\\/]/g, "-")
    .replace(/\.[a-z0-9]+$/i, "");
  return [360, 640, 960].map((width) => `/generated/responsive/${base}-${width}.webp ${width}w`).join(", ");
}

function audioUrlFor(item: any, locale: "en" | "ru") {
  return locale === "ru"
    ? item.audio_url_ru || item.audio_ru || item.audio_url || item.audio || null
    : item.audio_url_en || item.audio_en || item.audio_url || item.audio || null;
}

function spotifyUrlFor(item: any, locale: "en" | "ru") {
  return locale === "ru"
    ? item.spotify_url_ru || item.spotify_ru || item.spotify_url || item.spotify || null
    : item.spotify_url_en || item.spotify_en || item.spotify_url || item.spotify || null;
}

export function toHomePost(item: any, locale: "en" | "ru"): HomePost {
  const id = item.post_id;
  const text = locale === "ru" ? item.text || "" : item.text_en || item.text || "";
  const title = getFirstSentence(text) || (locale === "ru" ? `Пост ${id}` : `Post ${id}`);
  const badge = getSmartBadge(locale === "ru" ? text : item.text || text);
  const categorySlug = categorySlugFromBadge(badge);
  const visualMedia = postVisualMedia(item, locale);
  const visualPath = existingSiteImage(visualMedia?.path);
  const posterPath = existingSiteImage(visualMedia?.poster);
  const fallbackOgPath = existingSiteImage(postOgImagePath(item, locale));
  const image = visualPath || fallbackOgPath;
  const mediaType = visualPath ? visualMedia?.type || "image" : fallbackOgPath ? "image" : null;
  const slug = locale === "ru" ? item.slug_ru : item.slug_en;

  return {
    id,
    url: locale === "ru" ? `/ru/${id}/${slug}/` : `/${id}/${slug}/`,
    title,
    body: text,
    excerpt: excerptAfterTitle(text, title, 180),
    date: item.date,
    relativeDate: formatRelativeTime(item.date, locale),
    image,
    fallbackImage: posterPath || fallbackOgPath,
    mediaType,
    audioUrl: audioUrlFor(item, locale),
    spotifyUrl: spotifyUrlFor(item, locale),
    imageSrcSet: visualPath && mediaType === "image" ? responsiveSrcSetFor(postImagePath(item, locale)) : undefined,
    views: Number(item.views || 0),
    categorySlug,
    category: categoryLabel(categorySlug, locale),
  };
}

export function sortedHomePosts(feedItems: any[], locale: "en" | "ru") {
  return feedItems
    .filter((item) => (locale === "ru" ? item.has_ru && item.text && item.post_id : item.has_en && item.text_en && item.post_id))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .map((item) => toHomePost(item, locale));
}

export function topicStatsFor(posts: HomePost[]) {
  return Array.from(
    posts
      .reduce((map, post) => {
        const current = map.get(post.categorySlug) || { slug: post.categorySlug, label: post.category, count: 0 };
        current.count += 1;
        map.set(post.categorySlug, current);
        return map;
      }, new Map<string, { slug: string; label: string; count: number }>())
      .values(),
  ).sort((a, b) => b.count - a.count);
}
