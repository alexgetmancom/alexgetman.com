/* Тип поста, который понимают чистые контроллеры плеера (progress, analytics,
 * media, discussion). Плеер (features/story-player) передаёт сюда PlayerPost
 * напрямую — поля объявлены `| null` там, где PlayerPost допускает null,
 * чтобы это был реальный подтип без приведения через `unknown`. */
export type StoryPost = {
  id?: string | number;
  url: string;
  image?: string | null;
  fallbackImage?: string | null;
  imageSrcSet?: string;
  posterSrc?: string | null;
  mediaType: "image" | "video" | null;
  gallery?: Array<{ type: "image" | "video"; path: string | null; poster?: string | null }>;
  title: string;
  category: string;
  relativeDate: string;
  views?: string;
  audioUrl?: string | null;
  body?: string | string[];
  excerpt?: string;
  collapse?: string;
  readMore?: string;
  feedModes?: string[];
  __preloaded?: boolean;
};
