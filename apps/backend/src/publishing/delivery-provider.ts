import type { BackendConfig } from "../foundation/config.js";
import type { VideoTarget } from "./video-types.js";

type DeliveryProvider = "native" | "zernio";
type VideoDeliveryRoute = { provider: DeliveryProvider; accountId?: string };

/** Resolves a route before a target is scheduled; the resolved provider is then persisted on the target. */
export function videoDeliveryRoute(config: BackendConfig, target: VideoTarget): VideoDeliveryRoute {
  if (target !== "instagram_reels") return { provider: "native" };
  const route = config.PUBLISH_PROVIDER_ROUTES_JSON.instagram_reels;
  return route?.provider === "zernio"
    ? { provider: "zernio", ...(route.accountId ? { accountId: route.accountId } : {}) }
    : { provider: "native" };
}

export function isZernioRouteReady(config: BackendConfig, route: VideoDeliveryRoute): boolean {
  return route.provider !== "zernio" || Boolean(config.ZERNIO_API_KEY && route.accountId);
}
