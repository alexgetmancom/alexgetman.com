import type { TargetId } from "../../botTargets.js";
import { type ConnectPlatform, startConnect } from "../../channels/connect.js";
import { type MetaOauthPlatform, metaOauthConnectPath, metaOauthConnectUrl } from "../../channels/meta-oauth.js";
import { type ChannelInput, listChannels, registerChannel, registerTargetChannel } from "../../channels/registry.js";
import { xOauthConnectPath, xOauthConnectUrl } from "../../channels/x-oauth.js";
import { type ZernioConnectionKey, type ZernioConnectionOption, zernioConnectionOptions } from "../../channels/zernio-connections.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { listZernioAccounts, type ZernioAccount, zernioAccount } from "../../foundation/external/zernio.js";
import { channelReadiness } from "../../observability/capabilities.js";
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
    report(enabledOnly = true) {
      return trackUsageSync(backendDb, "studio.channel.list", () => {
        const readiness = channelReadiness(config, backendDb);
        return listChannels(backendDb, enabledOnly).map((channel) => {
          const state = readiness.get(channel.targetId ?? channel.id);
          return { ...channel, status: channel.enabled === 0 ? "disabled" : (state?.status ?? "ready"), missing: state?.missing ?? [] };
        });
      });
    },
    connect(input: Omit<ChannelInput, "source">) {
      return trackUsageSync(backendDb, "studio.channel.connect", () => registerChannel(backendDb, { ...input, source: "interface" }));
    },
    connectTarget(targetId: TargetId, provider = "native", providerAccountId?: string, label?: string) {
      return trackUsageSync(backendDb, "studio.channel.connect", () =>
        registerTargetChannel(backendDb, targetId, {
          provider,
          ...(providerAccountId ? { providerAccountId } : {}),
          ...(label ? { label } : {}),
          source: "interface",
        }),
      );
    },
    disable(channelId: string) {
      return trackUsageSync(backendDb, "studio.channel.disable", () => {
        const channel = backendDb.channels.get(channelId);
        if (!channel) throw new Error(`Unknown channel: ${channelId}`);
        backendDb.channels.disable(channelId, new Date().toISOString());
        return channel;
      });
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
    async discoverZernioConnections(locale: "ru" | "en"): Promise<ZernioConnectionOption[]> {
      return trackUsageAsync(backendDb, "studio.channel.discover", async () =>
        (await listZernioAccounts(config, fetchImpl)).flatMap((account) => zernioConnectionOptions(account, locale)),
      );
    },
    async connectZernio(accountId: string, locale: "ru" | "en", key: ZernioConnectionKey) {
      return trackUsageAsync(backendDb, "studio.channel.connect", async () => {
        const account = await zernioAccount(config, accountId, fetchImpl);
        const option = zernioConnectionOptions(account, locale).find((candidate) => candidate.key === key);
        if (!option) throw new Error("Zernio account does not serve that publication route");
        return registerChannel(backendDb, { ...option.input, source: "interface" });
      });
    },
  };
}
