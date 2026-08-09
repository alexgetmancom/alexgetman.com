import type { BackendDb } from "../db/client.js";
import type { VideoLocale } from "../publishing/video-types.js";
import { type ChannelConnection, registerChannel } from "./registry.js";

export type ChannelConnectInput = {
  platform: string;
  locale: VideoLocale;
  provider: string;
  targetId?: string;
  accountId?: string;
  label?: string;
  source?: string;
};

/** Persists one channel route shared by every Studio interface. */
export function persistChannelConnection(backendDb: BackendDb, input: ChannelConnectInput): ChannelConnection {
  const channel = registerChannel(backendDb, {
    platform: input.platform,
    locale: input.locale,
    provider: input.provider,
    ...(input.targetId ? { targetId: input.targetId } : {}),
    ...(input.accountId ? { providerAccountId: input.accountId } : {}),
    ...(input.label ? { label: input.label } : {}),
    source: input.source ?? "interface",
  });
  return channel;
}
