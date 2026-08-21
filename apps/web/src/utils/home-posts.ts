import fs from "node:fs";
import path from "node:path";
import type { HomePost } from "../components/home-news/types";
import type { FeedItem } from "../server/public-site";
import { formatRelativeTime } from "./dates";
import { postMediaGallery, postSocialImagePath, responsiveImageSrcSet, responsiveVariantFor } from "./media";
import { hasPublishedLocale } from "./public-feed";
import { categoryLabel, categorySlugFromBadge, getSmartBadge } from "./taxonomy";
import { excerptAfterTitle, getFirstSentence } from "./text";

const WEB_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const PUBLIC_ROOT = path.join(WEB_ROOT, "public");

/** Post pages render server-side on every request, and each post asks about its
 * cover, poster and every gallery entry — four existsSync calls apiece. Results
 * are cached per resolved file path: media filenames carry a `?v=<hash>` cache
 * key, so a replaced file arrives under a path this map has never seen. Only
 * hits are cached: media is materialized lazily, and a path that is missing now
 * can legitimately exist on the next request. The key carries the resolution
 * roots, because the same public path resolves to different files when
 * DATA_DIR or the working directory changes. */
const siteImageCache = new Set<string>();

export function existingSiteImage(publicPath: string | null | undefined) {
  if (!publicPath) return null;
  const normalizedPath = String(publicPath).replace(/^\/+/, "");
  const siteRoot = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "site") : null;
  const cacheKey = `${siteRoot ?? ""}\0${process.cwd()}\0${normalizedPath}`;
  if (siteImageCache.has(cacheKey)) return normalizedPath;
  const filePath = normalizedPath.split(/[?#]/, 1)[0] ?? "";
  const candidates = [
    ...(siteRoot ? [path.join(siteRoot, filePath)] : []),
    path.join(PUBLIC_ROOT, filePath),
    path.resolve(process.cwd(), "public", filePath),
    path.resolve(process.cwd(), "apps/web/public", filePath),
  ];
  if (!candidates.some((candidate) => fs.existsSync(candidate))) return null;
  siteImageCache.add(cacheKey);
  return normalizedPath;
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
  const badge = getSmartBadge(text);
  const categorySlug = categorySlugFromBadge(badge);
  const gallery = postMediaGallery(item, locale);
  const visualMedia = gallery[0] ?? null;
  const visualPath = existingSiteImage(visualMedia?.path);
  const posterPath = existingSiteImage(visualMedia?.poster);
  const fallbackImagePath = existingSiteImage(postSocialImagePath(item, locale)) || existingSiteImage("/social-image.jpg");
  const image = visualPath || fallbackImagePath;
  const mediaType = visualPath ? visualMedia?.type || "image" : fallbackImagePath ? "image" : null;
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
    fallbackImage: posterPath || fallbackImagePath,
    mediaType,
    gallery: gallery.filter((media) => existingSiteImage(media.path)),
    audioUrl: audioUrlFor(item, locale),
    spotifyUrl: spotifyUrlFor(item, locale),
    imageSrcSet:
      visualPath && mediaType === "image"
        ? responsiveImageSrcSet(visualMedia?.path)
        : responsiveImageSrcSet(posterPath || fallbackImagePath),
    posterSrc: mediaType === "video" ? responsiveVariantFor(posterPath || fallbackImagePath, 960) : undefined,
    views: Number(item.views || 0),
    categorySlug,
    category: categoryLabel(categorySlug, locale),
  };
}

export function sortedHomePosts(feedItems: readonly FeedItem[], locale: "en" | "ru"): HomePost[] {
  return feedItems
    .filter((item) => hasPublishedLocale(item, locale))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .map((item) => toHomePost(item, locale));
}
