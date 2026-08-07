/* The post shape the player's pure controllers understand (progress,
 * analytics, media). The player (features/story-player) passes PlayerPost
 * straight in — fields are declared `| null` wherever PlayerPost allows null,
 * so this is a genuine supertype and needs no cast through `unknown`. */
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
  __galleryPreloaded?: boolean;
};
