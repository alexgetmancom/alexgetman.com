import type { FeedItem, SiteMedia } from "../../../backend/src/public/site-read-model";

type FeedLocale = "en" | "ru";

type PostVisualMedia = { type: "image" | "video"; path: string; poster?: string };

function normalizePublicPath(value: string | null | undefined): string {
  return String(value || "").replace(/^\/+/, "");
}

function filePath(publicPath: string): string {
  return publicPath.split(/[?#]/, 1)[0] ?? "";
}

function cacheSuffix(publicPath: string): string {
  const index = publicPath.search(/[?#]/);
  return index === -1 ? "" : publicPath.slice(index);
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

export function postVisualMedia(item: FeedItem, locale: FeedLocale = "en"): PostVisualMedia | null {
  const directImage = normalizePublicPath(locale === "ru" ? item.image || item.image_en : item.image_en || item.image);
  if (directImage) return { type: "image", path: directImage };
  const media = localizedMedia(item, locale).find((entry) => entry.path);
  const path = normalizePublicPath(media?.path);
  if (!path) return null;
  const type = String(media?.type || "").toLowerCase() === "video" || /\.(mp4|webm|mov)$/i.test(filePath(path)) ? "video" : "image";
  const poster = type === "video" ? normalizePublicPath(media?.poster) : "";
  return poster ? { type, path, poster } : { type, path };
}

/** All renderable assets for a locale, in publishing order. The first one remains the card cover. */
export function postMediaGallery(item: FeedItem, locale: FeedLocale = "en"): PostVisualMedia[] {
  const directImage = normalizePublicPath(locale === "ru" ? item.image || item.image_en : item.image_en || item.image);
  const candidates = [
    ...(directImage ? [{ type: "image", path: directImage }] : []),
    ...localizedMedia(item, locale).map((media) => {
      const path = normalizePublicPath(media?.path);
      const type = String(media?.type || "").toLowerCase() === "video" || /\.(mp4|webm|mov)$/i.test(filePath(path)) ? "video" : "image";
      const poster = type === "video" ? normalizePublicPath(media?.poster) : "";
      return poster ? { type, path, poster } : { type, path };
    }),
  ];
  const seen = new Set<string>();
  return candidates.filter((media): media is PostVisualMedia => {
    if (!media.path || seen.has(media.path)) return false;
    seen.add(media.path);
    return true;
  });
}

export function postOgImagePath(item: FeedItem, locale: FeedLocale = "en"): string {
  return item.post_id ? `/og/posts/post-${item.post_id}-${locale === "ru" ? "ru" : "en"}.jpg` : "/social-image.jpg";
}

export function responsiveImageSrcSet(publicPath: string | null | undefined): string | undefined {
  const normalized = normalizePublicPath(publicPath);
  const source = filePath(normalized);
  if (!source || !/\.(png|jpe?g)$/i.test(source)) return undefined;
  const base = source.replace(/[\\/]/g, "-").replace(/\.[a-z0-9]+$/i, "");
  const suffix = cacheSuffix(normalized);
  return [360, 640, 960].map((width) => `/generated/responsive/${base}-${width}.webp${suffix} ${width}w`).join(", ");
}
