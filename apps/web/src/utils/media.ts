import type { FeedItem, SiteMedia } from "./feed";

type FeedLocale = "en" | "ru";

function normalizePublicPath(value: string | null | undefined): string {
  return String(value || "").replace(/^\/+/, "");
}

function localizedMedia(item: FeedItem, locale: FeedLocale): SiteMedia[] {
  const primary = locale === "ru" ? item.media : item.media_en;
  const fallback = locale === "ru" ? item.media_en : item.media;
  return Array.isArray(primary) && primary.length > 0 ? primary : Array.isArray(fallback) ? fallback : [];
}

export function postImagePath(item: FeedItem, locale: FeedLocale = "en"): string | null {
  const imageMedia = localizedMedia(item, locale).find((entry) => entry.type !== "video" && entry.path);
  const directImage = locale === "ru" ? item.image || item.image_en : item.image_en || item.image;
  return normalizePublicPath(directImage || imageMedia?.path) || null;
}

export function postVisualMedia(
  item: FeedItem,
  locale: FeedLocale = "en",
): { type: "image" | "video"; path: string; poster?: string } | null {
  const directImage = normalizePublicPath(locale === "ru" ? item.image || item.image_en : item.image_en || item.image);
  if (directImage) return { type: "image", path: directImage };
  const media = localizedMedia(item, locale).find((entry) => entry.path);
  const path = normalizePublicPath(media?.path);
  if (!path) return null;
  const type = String(media?.type || "").toLowerCase() === "video" || /\.(mp4|webm|mov)$/i.test(path) ? "video" : "image";
  const poster = type === "video" ? normalizePublicPath(media?.poster) : "";
  return poster ? { type, path, poster } : { type, path };
}

export function postOgImagePath(item: FeedItem, locale: FeedLocale = "en"): string {
  return item.post_id ? `/og/posts/post-${item.post_id}-${locale === "ru" ? "ru" : "en"}.jpg` : "/social-image.jpg";
}

export function responsiveImageSrcSet(publicPath: string | null | undefined): string | undefined {
  const normalized = normalizePublicPath(publicPath);
  if (!normalized || !/\.(png|jpe?g)$/i.test(normalized)) return undefined;
  const base = normalized.replace(/[\\/]/g, "-").replace(/\.[a-z0-9]+$/i, "");
  return [360, 640, 960].map((width) => `/generated/responsive/${base}-${width}.webp ${width}w`).join(", ");
}
