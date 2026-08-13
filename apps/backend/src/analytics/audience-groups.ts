/** Text platforms carry the written feed; video platforms carry Shorts/Reels.
 * The two audiences are counted separately everywhere — a single combined
 * total is dominated by whichever side is larger and says nothing useful about
 * either one. Keys are exactly the platforms `creator_profiles` can hold. */
export type AudienceGroup = "text" | "video";

const AUDIENCE_GROUPS: Record<string, AudienceGroup> = {
  telegram: "text",
  telegram_stories: "text",
  threads: "text",
  x: "text",
  instagram_stories: "text",
  instagram: "video",
  youtube: "video",
};

export function audienceGroup(platform: string): AudienceGroup | null {
  return (
    AUDIENCE_GROUPS[platform] ??
    (platform.startsWith("threads_") ? "text" : null) ??
    (platform.startsWith("youtube_") || platform.startsWith("instagram_") || platform.startsWith("tiktok_") ? "video" : null)
  );
}
