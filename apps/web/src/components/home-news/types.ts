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
