import { channelForVideo } from "../channels/registry.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import type { VideoLocale } from "../foundation/external/youtube.js";
import type { VideoTarget } from "./video-types.js";

type DeliveryProvider = "native" | "zernio";
type VideoDeliveryRoute = { provider: DeliveryProvider; accountId?: string };

export function registeredVideoDeliveryRoute(backendDb: BackendDb, target: VideoTarget, locale: VideoLocale = "ru"): VideoDeliveryRoute {
  const connection = channelForVideo(backendDb, target, locale);
  if (!connection) throw new Error(`Video channel is not connected: ${target}/${locale}`);
  return {
    provider: connection.provider === "zernio" ? "zernio" : "native",
    ...(connection.providerAccountId ? { accountId: connection.providerAccountId } : {}),
  };
}

export function isZernioRouteReady(config: BackendConfig, route: VideoDeliveryRoute): boolean {
  return route.provider !== "zernio" || Boolean(config.ZERNIO_API_KEY && route.accountId);
}
