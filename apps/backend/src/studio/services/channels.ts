import { credentialShape } from "../../channels/credentials.js";
import { isPublishableVideoPlatform, VIDEO_PLATFORM_TARGET } from "../../channels/destinations.js";
import { type ChannelConnectInput, persistChannelConnection } from "../../channels/management.js";
import { listChannels } from "../../channels/registry.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { requestJson } from "../../foundation/http.js";
import type { VideoLocale } from "../../publishing/video-types.js";

export type StudioZernioAccount = { _id?: string; username?: string; displayName?: string; platform?: string };
type ZernioAccounts = { accounts?: StudioZernioAccount[] } | StudioZernioAccount[];

/** Channel administration shared by Studio interfaces.
 *
 * Telegram renders the connection wizard, but it no longer owns channel
 * persistence, credential validation or provider discovery. This keeps those
 * operations available to Web Studio and MCP without copying the wizard's DB
 * logic into another adapter.
 */
export function channelService(backendDb: BackendDb, config: BackendConfig, fetchImpl: typeof fetch = fetch) {
  return {
    list(enabledOnly = true) {
      return listChannels(backendDb, enabledOnly);
    },
    isPublishablePlatform(platform: string): boolean {
      return isPublishableVideoPlatform(platform);
    },
    nativeConnectablePlatforms(): string[] {
      return Object.keys(VIDEO_PLATFORM_TARGET).filter(isPublishableVideoPlatform);
    },
    credentialShape(platform: string, provider: string, locale: VideoLocale) {
      return credentialShape(platform, provider, locale);
    },
    connect(input: Omit<ChannelConnectInput, "source">) {
      return persistChannelConnection(backendDb, config, { ...input, source: "interface" });
    },
    async discoverZernioAccounts(): Promise<StudioZernioAccount[]> {
      if (!config.ZERNIO_API_KEY) throw new Error("Zernio API key is not configured.");
      const response = await requestJson<ZernioAccounts>(fetchImpl, "https://zernio.com/api/v1/accounts", {
        headers: { Authorization: `Bearer ${config.ZERNIO_API_KEY}` },
      });
      return Array.isArray(response) ? response : (response.accounts ?? []);
    },
  };
}
