import fs from "node:fs";
import path from "node:path";
import type { HomePost } from "../components/home-news/types";
import type { FeedItem } from "../server/public-site";
import { formatRelativeTime } from "./dates";
import { postImagePath, postMediaGallery, postOgImagePath, postVisualMedia } from "./media";
import { categoryLabel, categorySlugFromBadge, getSmartBadge } from "./taxonomy";
import { excerptAfterTitle, getFirstSentence } from "./text";

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

function responsiveBaseFor(publicPath: string | null | undefined): string | null {
  if (!publicPath || !/\.(png|jpe?g)$/i.test(publicPath)) return null;
  return String(publicPath)
    .replace(/^\/+/, "")
    .replace(/[\\/]/g, "-")
    .replace(/\.[a-z0-9]+$/i, "");
}

/** Variants are produced on demand by pages/generated/responsive/[...file].ts,
 * so the srcset is emitted unconditionally for any resizable source. */
export function responsiveSrcSetFor(publicPath: string | null | undefined) {
  const base = responsiveBaseFor(publicPath);
  if (!base) return undefined;
  return [360, 640, 960].map((width) => `/generated/responsive/${base}-${width}.webp ${width}w`).join(", ");
}

export function responsiveVariantFor(publicPath: string | null | undefined, width: 360 | 640 | 960) {
  const base = responsiveBaseFor(publicPath);
  return base ? `generated/responsive/${base}-${width}.webp` : undefined;
}

function audioUrlFor(item: FeedItem, locale: "en" | "ru") {
  return (locale === "ru" ? item.audio_url_ru : item.audio_url_en) || null;
}

function spotifyUrlFor(item: FeedItem, locale: "en" | "ru") {
  return (locale === "ru" ? item.spotify_url_ru : item.spotify_url_en) || null;
}

export function toHomePost(item: FeedItem, locale: "en" | "ru"): HomePost {
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
    gallery: postMediaGallery(item, locale).filter((media) => existingSiteImage(media.path)),
    audioUrl: audioUrlFor(item, locale),
    spotifyUrl: spotifyUrlFor(item, locale),
    imageSrcSet:
      visualPath && mediaType === "image"
        ? responsiveSrcSetFor(postImagePath(item, locale))
        : responsiveSrcSetFor(posterPath || fallbackOgPath),
    posterSrc: mediaType === "video" ? responsiveVariantFor(posterPath || fallbackOgPath, 960) : undefined,
    views: Number(item.views || 0),
    categorySlug,
    category: categoryLabel(categorySlug, locale),
  };
}

export function sortedHomePosts(feedItems: readonly FeedItem[], locale: "en" | "ru"): HomePost[] {
  return feedItems
    .filter((item) => (locale === "ru" ? item.has_ru && item.text && item.post_id : item.has_en && item.text_en && item.post_id))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .map((item) => toHomePost(item, locale));
}
