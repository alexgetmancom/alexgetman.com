import { channelForVideo } from "../channels/registry.js";
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

/** Registry-aware route used by runtime workflows. The environment remains a
 * bootstrap/fallback so existing self-hosted installations migrate in place. */
export function registeredVideoDeliveryRoute(
  backendDb: BackendDb,
  config: BackendConfig,
  target: VideoTarget,
  locale: VideoLocale = "ru",
): VideoDeliveryRoute {
  const connection = channelForVideo(backendDb, target, locale);
  if (!connection) return videoDeliveryRoute(config, target, locale);
  return {
    provider: connection.provider === "zernio" ? "zernio" : "native",
    ...(connection.providerAccountId ? { accountId: connection.providerAccountId } : {}),
  };
}

export function isZernioRouteReady(config: BackendConfig, route: VideoDeliveryRoute): boolean {
  return route.provider !== "zernio" || Boolean(config.ZERNIO_API_KEY && route.accountId);
}
