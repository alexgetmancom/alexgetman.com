import { type ConnectPlatform, startConnect } from "../../channels/connect.js";
import { isPublishableVideoPlatform } from "../../channels/destinations.js";
import { type MetaOauthPlatform, metaOauthConnectPath, metaOauthConnectUrl } from "../../channels/meta-oauth.js";
import { type ChannelInput, listChannels, registerChannel } from "../../channels/registry.js";
import { xOauthConnectPath, xOauthConnectUrl } from "../../channels/x-oauth.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { listZernioAccounts, type ZernioAccount } from "../../foundation/external/zernio.js";
import { trackUsageAsync, trackUsageSync } from "../../observability/usage.js";

export type StudioZernioAccount = ZernioAccount;

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
      return trackUsageSync(backendDb, "studio.channel.list", () => listChannels(backendDb, enabledOnly));
    },
    isPublishablePlatform(platform: string): boolean {
      return isPublishableVideoPlatform(platform);
    },
    connect(input: Omit<ChannelInput, "source">) {
      return trackUsageSync(backendDb, "studio.channel.connect", () => registerChannel(backendDb, { ...input, source: "interface" }));
    },
    nativeConnectUrl(platform: MetaOauthPlatform, locale: "ru" | "en"): string | null {
      try {
        return metaOauthConnectUrl(config, platform, locale);
      } catch {
        return null;
      }
    },
    nativeConnectPath(platform: MetaOauthPlatform, locale: "ru" | "en"): string | null {
      try {
        return metaOauthConnectPath(config, platform, locale);
      } catch {
        return null;
      }
    },
    /** Starts a connection the way the CLI and the dashboard do. The bot needs
     * it for platforms whose flow is a code rather than a link. */
    startConnect(platform: ConnectPlatform, locale: "ru" | "en") {
      return startConnect(config, backendDb, platform, locale, fetchImpl);
    },
    xConnectUrl(): string | null {
      try {
        return xOauthConnectUrl(config);
      } catch {
        return null;
      }
    },
    xConnectPath(): string | null {
      try {
        return xOauthConnectPath(config);
      } catch {
        return null;
      }
    },
    async discoverZernioAccounts(): Promise<StudioZernioAccount[]> {
      return trackUsageAsync(backendDb, "studio.channel.discover", () => listZernioAccounts(config, fetchImpl));
    },
  };
}
