import type { VideoLocale } from "../publishing/video-types.js";

/** The durable identity shared by a platform connection, its credential and its analytics profile. */
export function channelIdentity<Platform extends string, Locale extends VideoLocale>(
  platform: Platform,
  locale: Locale,
): `${Platform}_${Locale}` {
  return `${platform}_${locale}`;
}
