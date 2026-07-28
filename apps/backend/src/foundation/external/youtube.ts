import type { BackendConfig } from "../config.js";
import { formBody, requestJson } from "../http.js";

type YouTubeToken = { access_token: string };
export type VideoLocale = "ru" | "en";

export function youtubeCredentials(config: BackendConfig, locale: VideoLocale) {
  return locale === "en"
    ? {
        clientId: config.YOUTUBE_EN_CLIENT_ID,
        clientSecret: config.YOUTUBE_EN_CLIENT_SECRET,
        refreshToken: config.YOUTUBE_EN_REFRESH_TOKEN,
      }
    : {
        clientId: config.YOUTUBE_CLIENT_ID,
        clientSecret: config.YOUTUBE_CLIENT_SECRET,
        refreshToken: config.YOUTUBE_REFRESH_TOKEN,
      };
}

/** Obtains a reusable OAuth token for YouTube API clients. */
export async function youtubeAccessToken(
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
  locale: VideoLocale = "ru",
): Promise<string> {
  const credentials = youtubeCredentials(config, locale);
  const body = formBody({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
    grant_type: "refresh_token",
  });
  return (await requestJson<YouTubeToken>(fetchImpl, "https://oauth2.googleapis.com/token", { method: "POST", body })).access_token;
}
