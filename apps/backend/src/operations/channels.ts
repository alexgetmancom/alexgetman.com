import { isPublishableVideoPlatform } from "../channels/destinations.js";

import { listChannels, registerChannel } from "../channels/registry.js";
import type { BackendDb } from "../db/client.js";
import type { VideoLocale } from "../publishing/video-types.js";

/**
 * Channel administration for interfaces other than the bot.
 *
 * The same operations the Telegram screen performs, so the answer to "where are
 * channels managed" is one service rather than one screen. Credentials are only
 * ever reported by name — an operations command must be able to say what a
 * channel is missing without printing what it has.
 */

type ChannelReport = {
  id: string;
  platform: string;
  locale: string;
  provider: string;
  providerAccountId: string | null;
  label: string;
  enabled: boolean;
  source: string;
  publishable: boolean;
};

export function channelReport(backendDb: BackendDb): ChannelReport[] {
  return listChannels(backendDb, false).map((channel) => {
    return {
      id: channel.id,
      platform: channel.platform,
      locale: channel.locale,
      provider: channel.provider,
      providerAccountId: channel.providerAccountId,
      label: channel.label,
      enabled: channel.enabled === 1,
      source: channel.source,
      // A text channel has no video target and is not expected to have one.
      publishable: channel.targetId ? true : isPublishableVideoPlatform(channel.platform),
    };
  });
}

export function connectChannel(
  backendDb: BackendDb,
  input: {
    platform: string;
    locale: VideoLocale;
    provider: string;
    targetId?: string;
    providerAccountId?: string;
    label?: string;
  },
): { id: string } {
  return { id: registerChannel(backendDb, { ...input, source: "cli" }).id };
}

/** Disabling keeps the row: its publications, metrics and audience history stay
 * attributable to the account they came from. */
export function disableChannel(backendDb: BackendDb, channelId: string): { id: string; disabled: boolean } {
  if (!backendDb.channels.get(channelId)) throw new Error(`unknown channel: ${channelId}`);
  backendDb.channels.disable(channelId, new Date().toISOString());
  return { id: channelId, disabled: true };
}
