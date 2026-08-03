import { eq } from "drizzle-orm";
import { credentialShape, deleteChannelSecrets, storedCredentialNames } from "../channels/credentials.js";
import { isPublishableVideoPlatform } from "../channels/destinations.js";
import { persistChannelConnection } from "../channels/management.js";
import { listChannels } from "../channels/registry.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { channelConnections } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import type { VideoLocale } from "../publishing/video-types.js";

/**
 * Channel administration for interfaces other than the bot.
 *
 * The same operations the Telegram screen performs, so the answer to "where are
 * channels managed" is one service rather than one screen. Credentials are only
 * ever reported by name — an operations command must be able to say what a
 * channel is missing without printing what it has.
 */

export type ChannelReport = {
  id: string;
  platform: string;
  locale: string;
  provider: string;
  providerAccountId: string | null;
  label: string;
  enabled: boolean;
  source: string;
  publishable: boolean;
  credentials: { stored: string[]; missing: string[] };
};

export function channelReport(backendDb: BackendDb, config: BackendConfig): ChannelReport[] {
  return listChannels(backendDb, false).map((channel) => {
    const locale: VideoLocale = channel.locale === "en" ? "en" : "ru";
    const stored = storedCredentialNames(backendDb, channel.id);
    const shape = credentialShape(channel.platform, channel.provider, locale);
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
      credentials: {
        stored,
        // Missing only counts what neither the store nor the environment has:
        // a Studio still configured entirely through variables is complete.
        missing: shape
          .filter((field) => !stored.includes(field.name) && !config[field.envVariable as keyof BackendConfig])
          .map((field) => field.name),
      },
    };
  });
}

export function connectChannel(
  backendDb: BackendDb,
  config: BackendConfig,
  input: {
    platform: string;
    locale: VideoLocale;
    provider: string;
    accountId?: string;
    label?: string;
    credentials: Record<string, string>;
  },
): { id: string; stored: string[] } {
  const result = persistChannelConnection(backendDb, config, { ...input, source: "cli" });
  return { id: result.channel.id, stored: result.stored };
}

/** Disabling keeps the row: its publications, metrics and audience history stay
 * attributable to the account they came from. */
export function disableChannel(backendDb: BackendDb, channelId: string, forgetCredentials: boolean): { id: string; disabled: boolean } {
  const updated = unsafeDb(backendDb)
    .db.update(channelConnections)
    .set({ enabled: 0, updatedAt: new Date().toISOString() })
    .where(eq(channelConnections.id, channelId))
    .returning({ id: channelConnections.id })
    .get();
  if (!updated) throw new Error(`unknown channel: ${channelId}`);
  if (forgetCredentials) deleteChannelSecrets(backendDb, channelId);
  return { id: channelId, disabled: true };
}
