/* Тип поста, который понимают чистые контроллеры плеера (progress, analytics,
 * media, discussion). Плеер (features/story-player) передаёт сюда PlayerPost —
 * поля совместимы. */
export type StoryPost = {
  id?: string | number;
  url: string;
  image?: string;
  fallbackImage?: string;
  imageSrcSet?: string;
  posterSrc?: string;
  mediaType: "image" | "video";
  gallery?: Array<{ type: "image" | "video"; path: string; poster?: string }>;
  title: string;
  category: string;
  relativeDate: string;
  views?: string;
  audioUrl?: string;
  body?: string | string[];
  excerpt?: string;
  collapse?: string;
  readMore?: string;
  feedModes?: string[];
  __preloaded?: boolean;
};
