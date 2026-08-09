import { eq } from "drizzle-orm";
import { isPublishableVideoPlatform } from "../channels/destinations.js";
import { persistChannelConnection } from "../channels/management.js";
import { listChannels } from "../channels/registry.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { channelConnections } from "../db/schema.js";
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
    accountId?: string;
    label?: string;
  },
): { id: string } {
  return { id: persistChannelConnection(backendDb, { ...input, source: "cli" }).id };
}

/** Disabling keeps the row: its publications, metrics and audience history stay
 * attributable to the account they came from. */
export function disableChannel(backendDb: BackendDb, channelId: string): { id: string; disabled: boolean } {
  const updated = unsafeDb(backendDb)
    .db.update(channelConnections)
    .set({ enabled: 0, updatedAt: new Date().toISOString() })
    .where(eq(channelConnections.id, channelId))
    .returning({ id: channelConnections.id })
    .get();
  if (!updated) throw new Error(`unknown channel: ${channelId}`);
  return { id: channelId, disabled: true };
}
