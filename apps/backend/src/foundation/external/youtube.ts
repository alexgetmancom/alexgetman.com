import type { BackendConfig } from "../config.js";
import { formBody, requestJson } from "../http.js";

type YouTubeToken = { access_token: string };

/** Obtains a reusable OAuth token for YouTube API clients. */
export async function youtubeAccessToken(config: BackendConfig, fetchImpl: typeof fetch = fetch): Promise<string> {
  const body = formBody({
    client_id: config.YOUTUBE_CLIENT_ID,
    client_secret: config.YOUTUBE_CLIENT_SECRET,
    refresh_token: config.YOUTUBE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  return (await requestJson<YouTubeToken>(fetchImpl, "https://oauth2.googleapis.com/token", { method: "POST", body })).access_token;
}
