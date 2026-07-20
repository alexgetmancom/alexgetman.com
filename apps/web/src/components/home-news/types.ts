export interface HomePost {
  id: number | string;
  url: string;
  title: string;
  body?: string;
  excerpt: string;
  date: string;
  relativeDate: string;
  image: string | null;
  fallbackImage?: string | null;
  mediaType?: "image" | "video" | null;
  gallery?: HomeMedia[];
  audioUrl?: string | null;
  spotifyUrl?: string | null;
  imageSrcSet?: string;
  posterSrc?: string;
  views: number;
  categorySlug: string;
  category: string;
}

export interface HomeMedia {
  type: "image" | "video";
  path: string;
  poster?: string;
}

export interface HomeLabels {
  empty: string;
}

export interface StoryUi {
  storyLabel: string;
  discuss: string;
  share: string;
  readMore: string;
  read: string;
  back: string;
  collapse: string;
  mute: string;
  muted: string;
  storyRail: string;
  feedMode: string;
  feedLatest: string;
  feedDeep: string;
  feedWatched: string;
  menu: string;
  language: string;
  telegram: string;
}
