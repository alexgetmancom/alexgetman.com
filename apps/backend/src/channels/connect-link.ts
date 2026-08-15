import type { BackendConfig } from "../foundation/config.js";
import type { VideoLocale } from "../publishing/video-types.js";
import { type MetaOauthPlatform, metaOauthConnectUrl } from "./meta-oauth.js";
import { xOauthAuthorizeUrl } from "./x-oauth.js";

/** Ten minutes, the life of the signed state each link carries. Stated with the
 * link because a link handed over in a chat is read later than it is made. */
const LINK_TTL_MINUTES = 10;

export const CONNECT_PLATFORMS = ["threads", "instagram", "x"] as const;
export type ConnectPlatform = (typeof CONNECT_PLATFORMS)[number];

/**
 * The link an operator opens to attach an account, without going through the
 * Command Center to get it.
 *
 * The browser flow already produced this link; only the dashboard could hand it
 * over, so connecting an account was a thing an operator could do and an
 * interface could not ask for. The link authorizes nothing by itself: it is
 * signed, short-lived, and the account is attached only by whoever approves the
 * platform's own consent screen.
 *
 * Meta's link goes through this Studio's start route, which is what carries the
 * destination language into the callback. X has no language and its start route
 * is guarded for the dashboard, so its link is the platform's own.
 */
export function connectLink(
  config: BackendConfig,
  platform: ConnectPlatform,
  locale: VideoLocale,
  now = new Date(),
): { platform: ConnectPlatform; locale: VideoLocale | null; url: string; expiresInMinutes: number } {
  const url = platform === "x" ? xOauthAuthorizeUrl(config, now) : metaOauthConnectUrl(config, platform as MetaOauthPlatform, locale, now);
  return { platform, locale: platform === "x" ? null : locale, url, expiresInMinutes: LINK_TTL_MINUTES };
}
