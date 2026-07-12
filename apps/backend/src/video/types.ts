export const VIDEO_TARGETS = ["youtube_shorts", "instagram_reels"] as const;
export type VideoTarget = (typeof VIDEO_TARGETS)[number];

export type YouTubeMetadata = { title: string; description: string; tags: string[] };
export type InstagramMetadata = { caption: string; hashtags: string[] };
export type VideoMetadata = YouTubeMetadata | InstagramMetadata;

export function videoTargetLabel(target: VideoTarget): string {
  return target === "youtube_shorts" ? "YouTube Shorts" : "Instagram Reels";
}
