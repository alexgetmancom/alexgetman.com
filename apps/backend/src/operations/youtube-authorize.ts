import type { BackendConfig } from "../foundation/config.js";
import { youtubeCredentials } from "../foundation/external/youtube.js";
import { formBody, requestJson } from "../foundation/http.js";
import type { VideoLocale } from "../publishing/video-types.js";

/**
 * Obtains the YouTube refresh token this Studio publishes with.
 *
 * The application only ever refreshes a token; getting the first one was a
 * consent flow the operator had to perform by hand, and it was the single step
 * a self-hosted install could not get past.
 *
 * This uses the device flow, which is the only one that fits: a Studio runs on
 * a server with no browser, and the alternatives need either a redirect back to
 * a reachable URL or a loopback address that is not the operator's machine.
 * Device flow supports `auth/youtube` but not `auth/youtube.upload`; the
 * general scope is one of the four `videos.insert` accepts, so it is the scope
 * to ask for.
 *
 * Each Studio uses its own Google Cloud project on purpose. YouTube quota is
 * counted per project rather than per user, so one shared client would give
 * every install together a handful of uploads a day, and publishing on someone
 * else's behalf would put this project through Google's verification.
 */
const DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/youtube";

type DeviceCode = {
  device_code: string;
  user_code: string;
  verification_url: string;
  interval?: number;
  expires_in?: number;
};

type TokenResponse = { refresh_token?: string; error?: string };

export type YouTubeAuthorization = {
  locale: VideoLocale;
  variable: string;
  refreshToken: string;
  note: string;
};

export type AuthorizePrompt = { verificationUrl: string; userCode: string; expiresInSeconds: number };

export async function authorizeYouTube(
  config: BackendConfig,
  locale: VideoLocale,
  options: {
    fetchImpl?: typeof fetch;
    onPrompt?: (prompt: AuthorizePrompt) => void;
    waitSeconds?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<YouTubeAuthorization> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const { clientId, clientSecret } = youtubeCredentials(config, locale);
  const suffix = locale === "en" ? "EN" : "RU";
  if (!clientId || !clientSecret)
    throw new Error(
      `Set YOUTUBE_${suffix}_CLIENT_ID and YOUTUBE_${suffix}_CLIENT_SECRET first. Create them in Google Cloud as an OAuth client of type "TV and Limited Input devices".`,
    );

  const device = await requestJson<DeviceCode>(fetchImpl, DEVICE_CODE_URL, {
    method: "POST",
    body: formBody({ client_id: clientId, scope: SCOPE }),
  });
  const expiresIn = device.expires_in ?? 1800;
  options.onPrompt?.({ verificationUrl: device.verification_url, userCode: device.user_code, expiresInSeconds: expiresIn });

  // Google states the polling interval and refuses a caller that ignores it.
  const intervalMs = (device.interval ?? 5) * 1000;
  const deadline = Date.now() + Math.min(options.waitSeconds ?? 300, expiresIn) * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const token = await requestJson<TokenResponse>(fetchImpl, TOKEN_URL, {
      method: "POST",
      body: formBody({
        client_id: clientId,
        client_secret: clientSecret,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    }).catch((error: unknown) => ({ error: String(error) }) as TokenResponse);

    if (token.refresh_token)
      return {
        locale,
        variable: `YOUTUBE_${suffix}_REFRESH_TOKEN`,
        refreshToken: token.refresh_token,
        note: "Put this in .env and restart. It does not expire unless the grant is revoked.",
      };
    // Still waiting for the operator to approve; anything else is terminal.
    if (!token.error?.includes("authorization_pending") && !token.error?.includes("slow_down"))
      throw new Error(`YouTube refused the authorization: ${token.error ?? "unknown error"}`);
  }
  throw new Error("Timed out waiting for approval. Run this again and finish the consent screen while it waits.");
}
