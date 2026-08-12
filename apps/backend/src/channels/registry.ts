import type { ChannelConnectionRecord } from "../application/ports.js";
import type { BackendDb } from "../db/client.js";
import type { VideoLocale } from "../foundation/external/youtube.js";
import { VIDEO_TARGET_PLATFORM, type VideoTarget } from "../publishing/video-types.js";

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

export function registeredPostTargetIds(backendDb: BackendDb): Set<string> {
  return new Set(
    listChannels(backendDb)
      .map((connection) => connection.targetId)
      .filter((target): target is string => Boolean(target)),
  );
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
