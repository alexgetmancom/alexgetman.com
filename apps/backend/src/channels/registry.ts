import type { ChannelConnectionRecord } from "../application/ports.js";
import type { BackendDb } from "../db/client.js";
import type { VideoLocale } from "../foundation/external/youtube.js";
import { ACCOUNT_PLATFORMS, VIDEO_TARGET_PLATFORM, type VideoTarget } from "../publishing/video-types.js";

export type ChannelConnection = ChannelConnectionRecord;

function channelId(platform: string, locale: VideoLocale): string {
  return `${platform}_${locale}`;
}

export function listChannels(backendDb: BackendDb, enabledOnly = true): ChannelConnection[] {
  return backendDb.channels
    .list(enabledOnly)
    .sort((left, right) => left.platform.localeCompare(right.platform) || left.locale.localeCompare(right.locale));
}

export type ChannelInput = {
  platform: string;
  locale: VideoLocale;
  provider: string;
  providerAccountId?: string;
  targetId?: string;
  label?: string;
  source?: string;
};

export function registerChannel(backendDb: BackendDb, input: ChannelInput): ChannelConnection {
  // A channel is either a text target this Studio publishes to or a platform
  // the video pipeline can reach. Anything else is a row that can never
  // publish, and nothing downstream would say so: the credential report asks
  // what such a channel requires, is told nothing, and reports it ready.
  if (!input.targetId && !ACCOUNT_PLATFORMS.includes(input.platform as (typeof ACCOUNT_PLATFORMS)[number])) {
    const known = ACCOUNT_PLATFORMS.join(", ");
    throw new Error(`Unknown platform: ${input.platform}. Account platforms are ${known}; a text channel names its target instead.`);
  }
  // Instagram's Story is served by the Instagram account, so connecting it
  // separately would store the same account twice and let the two disagree
  // about which provider carries it.
  if (input.targetId && Object.values(INSTAGRAM_STORY_TARGET).includes(input.targetId))
    throw new Error(`${input.targetId} is served by the Instagram account: connect the instagram platform for ${input.locale} instead`);
  const now = new Date().toISOString();
  const id = input.targetId ?? channelId(input.platform, input.locale);
  backendDb.channels.upsert(
    {
      id,
      platform: input.platform,
      locale: input.locale,
      provider: input.provider,
      providerAccountId: input.providerAccountId ?? null,
      targetId: input.targetId ?? null,
      label: input.label ?? `${displayPlatform(input.platform)} ${input.locale.toUpperCase()}`,
      enabled: 1,
      source: input.source ?? "interface",
    },
    now,
  );
  const connection = backendDb.channels.get(id);
  if (!connection) throw new Error(`Channel registration did not persist: ${id}`);
  return connection;
}

/** How each connected text or story target is delivered, by target id.
 *
 * The registry has always carried a provider per channel, but only the video
 * pipeline read it, so a Threads or Stories channel connected through a
 * provider still demanded the platform's own tokens and still published
 * natively. Delivery reads this instead of the database: it needs the routing,
 * not the registry.
 */
export function targetRouting(backendDb: BackendDb): Record<string, { provider: string; accountId: string | null }> {
  const routing: Record<string, { provider: string; accountId: string | null }> = {};
  for (const channel of listChannels(backendDb))
    for (const target of channelTargets(channel)) routing[target] = { provider: channel.provider, accountId: channel.providerAccountId };
  return routing;
}

export function registeredPostTargetIds(backendDb: BackendDb): Set<string> {
  return new Set(listChannels(backendDb).flatMap(channelTargets));
}

/** The story target an Instagram account also serves, by the account's language.
 *
 * Connecting Instagram is connecting the account, not one of the two things it
 * publishes: the Reel and the Story reach the same profile with the same
 * credential, native or through the provider. Kept as two target ids because
 * that is what a publication names, and the asymmetric spelling is the one
 * every publication in the database already uses. */
const INSTAGRAM_STORY_TARGET: Record<string, string> = { ru: "instagram_stories_ru", en: "instagram_stories" };

/** Every publication target one connected channel serves. A text or story route
 * names its own; an Instagram account brings its Story target with it. */
export function channelTargets(channel: ChannelConnection): string[] {
  if (channel.targetId) return [channel.targetId];
  if (channel.platform !== "instagram") return [];
  const story = INSTAGRAM_STORY_TARGET[channel.locale];
  return story ? [story] : [];
}

/** The registry is the only source of enabled publication targets. */
export function effectivePostTargets(backendDb: BackendDb, targets: Record<string, boolean>): Record<string, boolean> {
  const registered = registeredPostTargetIds(backendDb);
  return Object.fromEntries(Object.entries(targets).map(([target, enabled]) => [target, enabled && registered.has(target)]));
}

export function channelForVideo(backendDb: BackendDb, target: VideoTarget, locale: VideoLocale): ChannelConnection | undefined {
  const platform = VIDEO_TARGET_PLATFORM[target];
  return backendDb.channels.find(platform, locale) ?? undefined;
}

function displayPlatform(platform: string): string {
  return platform === "youtube" ? "YouTube" : platform === "instagram" ? "Instagram" : platform[0]?.toUpperCase() + platform.slice(1);
}
