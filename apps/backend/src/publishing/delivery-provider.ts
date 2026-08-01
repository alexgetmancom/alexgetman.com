import { channelForVideo, hasChannelRegistry } from "../channels/registry.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import type { VideoLocale } from "../foundation/external/youtube.js";
import type { VideoTarget } from "./video-types.js";

type DeliveryProvider = "native" | "zernio";
type VideoDeliveryRoute = { provider: DeliveryProvider; accountId?: string };

/** Resolves a route before a target is scheduled; the resolved provider is then persisted on the target. */
export function videoDeliveryRoute(config: BackendConfig, target: VideoTarget, locale: VideoLocale = "ru"): VideoDeliveryRoute {
  if (target !== "instagram_reels") return { provider: "native" };
  const route = config.PUBLISH_PROVIDER_ROUTES_JSON[locale === "en" ? "instagram_reels_en" : "instagram_reels"];
  return route?.provider === "zernio"
    ? { provider: "zernio", ...(route.accountId ? { accountId: route.accountId } : {}) }
    : { provider: "native" };
}

/**
 * The route a runtime workflow uses. The registry answers it.
 *
 * The environment is consulted only while the registry is empty — a database
 * that has not been bootstrapped yet, or a fixture. Once channels exist, a
 * missing connection means "this Studio does not publish there", not "look the
 * answer up somewhere else": two authoritative sources for the same question is
 * how a channel disabled in an interface keeps publishing from a stale variable.
 */
export function registeredVideoDeliveryRoute(
  backendDb: BackendDb,
  config: BackendConfig,
  target: VideoTarget,
  locale: VideoLocale = "ru",
): VideoDeliveryRoute {
  const connection = channelForVideo(backendDb, target, locale);
  if (!connection) return hasChannelRegistry(backendDb) ? { provider: "native" } : videoDeliveryRoute(config, target, locale);
  return {
    provider: connection.provider === "zernio" ? "zernio" : "native",
    ...(connection.providerAccountId ? { accountId: connection.providerAccountId } : {}),
  };
}

export function isZernioRouteReady(config: BackendConfig, route: VideoDeliveryRoute): boolean {
  return route.provider !== "zernio" || Boolean(config.ZERNIO_API_KEY && route.accountId);
}
