/** Text platforms carry the written feed; video platforms carry Shorts/Reels.
 * The two audiences are counted separately everywhere — a single combined
 * total is dominated by whichever side is larger and says nothing useful about
 * either one. Keys are exactly the platforms `creator_profiles` can hold. */
export type AudienceGroup = "text" | "video";

type AudienceConnection = {
  id: string;
  platform: string;
  provider: string;
  providerAccountId: string | null;
  targetId: string | null;
};

const AUDIENCE_GROUPS: Record<string, AudienceGroup> = {
  telegram: "text",
  telegram_stories: "text",
  threads: "text",
  x: "text",
  instagram_stories: "text",
  instagram_stories_ru: "text",
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

/** One provider account is one audience even when it serves several delivery
 * routes. Prefer the account connection over a target connection because it has
 * the richer profile collector (Instagram Reels over Instagram Stories). */
export function uniqueAudienceConnections<T extends AudienceConnection>(connections: readonly T[]): T[] {
  const selected = new Map<string, T>();
  for (const connection of [...connections].sort((left, right) => Number(Boolean(left.targetId)) - Number(Boolean(right.targetId)))) {
    const key = audienceConnectionIdentity(connection);
    if (!selected.has(key)) selected.set(key, connection);
  }
  return [...selected.values()];
}

export function audienceConnectionIdentity(connection: AudienceConnection): string {
  if (!connection.providerAccountId) return `channel:${connection.id}`;
  const family = connection.platform.startsWith("instagram")
    ? "instagram"
    : connection.platform.startsWith("threads")
      ? "threads"
      : connection.platform.startsWith("youtube")
        ? "youtube"
        : connection.platform;
  return `${connection.provider}:${family}:${connection.providerAccountId}`;
}
