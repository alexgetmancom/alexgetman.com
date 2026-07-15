/**
 * A read-only description of what each delivery adapter will do with a draft's
 * media. It is deliberately kept beside publishing rather than in a UI: every
 * interface (Telegram, MCP, a future Discord adapter) sees the same result.
 */
type MediaPolicy = {
  target: string;
  inputCount: number;
  deliveredCount: number;
  mode: "all" | "limited" | "first" | "story-first";
  note: string | null;
};

export function mediaPolicyForTarget(target: string, media: unknown[]): MediaPolicy {
  const inputCount = media.length;
  const first = (mode: MediaPolicy["mode"], note: string): MediaPolicy => ({
    target,
    inputCount,
    deliveredCount: Math.min(inputCount, 1),
    mode,
    note: inputCount > 1 ? note : null,
  });
  const limited = (limit: number, label: string): MediaPolicy => ({
    target,
    inputCount,
    deliveredCount: Math.min(inputCount, limit),
    mode: inputCount > limit ? "limited" : "all",
    note: inputCount > limit ? `${label} receives at most ${limit} media items.` : null,
  });

  if (target === "telegram") return limited(10, "Telegram");
  if (target === "bluesky" || target === "mastodon") return limited(4, target === "bluesky" ? "Bluesky" : "Mastodon");
  if (target === "linkedin") return limited(20, "LinkedIn");
  if (target === "instagram_story" || target === "instagram_stories" || target.startsWith("instagram_stories"))
    return first("story-first", "Stories use a single rendered asset made from the first source item.");
  if (target === "telegram_story" || target === "telegram_stories")
    return first("story-first", "Stories use a single rendered asset made from the first source item.");
  if (target === "facebook" || target === "facebook_ru") {
    const hasVideo = media.some((item) => isVideo(item));
    return hasVideo ? first("first", "Facebook publishes the first video when the selection contains video.") : all(target, inputCount);
  }
  if (target === "devto") return first("first", "Dev.to uses the first image as its cover and inline image.");
  return all(target, inputCount);
}

function all(target: string, inputCount: number): MediaPolicy {
  return { target, inputCount, deliveredCount: inputCount, mode: "all", note: null };
}

function isVideo(item: unknown): boolean {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const value = item as Record<string, unknown>;
  return String(value.type ?? value.media_type ?? "").toLowerCase() === "video";
}
