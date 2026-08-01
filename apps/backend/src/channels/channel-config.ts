import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import type { VideoLocale, VideoTarget } from "../publishing/video-types.js";
import { credentialEnvironment } from "./credentials.js";
import { channelFor, videoPlatform } from "./registry.js";

/**
 * A configuration view for one channel: the deployment's, with that channel's
 * own credentials laid over it.
 *
 * The overlay is applied at the few entry points that already hold the database
 * — publishing a video, collecting its metrics, syncing its profile — so every
 * publisher and API client below them keeps its existing configuration seam and
 * no longer has to know where a secret came from.
 *
 * A channel with no stored credentials returns the configuration untouched,
 * which is what keeps a Studio still configured entirely through environment
 * variables working exactly as before.
 */
export function channelConfig<T extends BackendConfig>(backendDb: BackendDb, config: T, platform: string, locale: VideoLocale): T {
  const channel = channelFor(backendDb, platform, locale);
  if (!channel) return config;
  const overrides = credentialEnvironment(backendDb, config.CHANNEL_SECRET_KEY, channel);
  return Object.keys(overrides).length ? ({ ...config, ...overrides } as T) : config;
}

export function videoChannelConfig<T extends BackendConfig>(backendDb: BackendDb, config: T, target: VideoTarget, locale: VideoLocale): T {
  return channelConfig(backendDb, config, videoPlatform(target), locale);
}
