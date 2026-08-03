import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import type { VideoLocale } from "../publishing/video-types.js";
import { credentialShape, setChannelSecrets } from "./credentials.js";
import { type ChannelConnection, registerChannel } from "./registry.js";

export type ChannelConnectInput = {
  platform: string;
  locale: VideoLocale;
  provider: string;
  accountId?: string;
  label?: string;
  credentials?: Record<string, string>;
  source?: string;
};

/** Persists a channel and its encrypted credentials for every Studio adapter. */
export function persistChannelConnection(
  backendDb: BackendDb,
  config: BackendConfig,
  input: ChannelConnectInput,
): { channel: ChannelConnection; stored: string[] } {
  const credentials = input.credentials ?? {};
  const shape = credentialShape(input.platform, input.provider, input.locale);
  const missing = shape.filter((field) => !credentials[field.name]).map((field) => field.name);
  if (missing.length && input.provider === "native") throw new Error(`missing credentials: ${missing.join(", ")}`);
  const channel = registerChannel(backendDb, {
    platform: input.platform,
    locale: input.locale,
    provider: input.provider,
    ...(input.accountId ? { providerAccountId: input.accountId } : {}),
    ...(input.label ? { label: input.label } : {}),
    source: input.source ?? "interface",
  });
  const stored = Object.keys(credentials).length ? setChannelSecrets(backendDb, config.CHANNEL_SECRET_KEY, channel.id, credentials) : [];
  return { channel, stored };
}
