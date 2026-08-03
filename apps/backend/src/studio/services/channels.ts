import { credentialShape, setChannelSecrets } from "../../channels/credentials.js";
import { isPublishableVideoPlatform, VIDEO_PLATFORM_TARGET } from "../../channels/destinations.js";
import { listChannels, registerChannel } from "../../channels/registry.js";
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
export function channelService(backendDb: BackendDb, config: BackendConfig) {
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
    connect(input: {
      platform: string;
      locale: VideoLocale;
      provider: string;
      accountId?: string;
      label?: string;
      credentials?: Record<string, string>;
    }) {
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
        source: "interface",
      });
      const stored = Object.keys(credentials).length
        ? setChannelSecrets(backendDb, config.CHANNEL_SECRET_KEY, channel.id, credentials)
        : [];
      return { channel, stored };
    },
    async discoverZernioAccounts(): Promise<StudioZernioAccount[]> {
      if (!config.ZERNIO_API_KEY) throw new Error("Zernio API key is not configured.");
      const response = await requestJson<ZernioAccounts>(fetch, "https://zernio.com/api/v1/accounts", {
        headers: { Authorization: `Bearer ${config.ZERNIO_API_KEY}` },
      });
      return Array.isArray(response) ? response : (response.accounts ?? []);
    },
  };
}
