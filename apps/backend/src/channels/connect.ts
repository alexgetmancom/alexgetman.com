import { eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { deviceAuthorizations } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { youtubeCredentials } from "../foundation/external/youtube.js";
import { formBody, requestJson } from "../foundation/http.js";
import { log } from "../foundation/logger.js";
import { encryptionKey, open, seal } from "../foundation/secret-box.js";
import type { VideoLocale } from "../publishing/video-types.js";
import { metaOauthConnectUrl } from "./meta-oauth.js";
import { META_PROVIDERS, type MetaOauthPlatform } from "./meta-providers.js";
import { registerChannel } from "./registry.js";
import { xOauthAuthorizeUrl } from "./x-oauth.js";
import { installYouTubeToken, youtubeTokenTarget } from "./youtube-tokens.js";

/** Ten minutes, the life of the signed state a redirect link carries. Stated
 * with the link because a link handed over in a chat is read later than made. */
const LINK_TTL_MINUTES = 10;
const DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const YOUTUBE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Device flow supports `auth/youtube` but not `auth/youtube.upload`, and the
 * general scope is one of the four `videos.insert` accepts. */
const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube";

export const CONNECT_PLATFORMS = ["threads", "instagram", "x", "youtube"] as const;
export type ConnectPlatform = (typeof CONNECT_PLATFORMS)[number];

/**
 * How one platform is connected, as data.
 *
 * Two shapes, not one: most platforms send the operator to a consent screen and
 * come back to a route, while YouTube hands out a code to type on another
 * screen and answers by polling. That is a real difference in what a connection
 * is, so it is an explicit kind rather than a branch inside a flow pretending
 * they are the same. Everything else — who can be connected, what it needs,
 * whether this Studio keeps one account per language — is shared, which is why
 * every surface asks this table and none of them knows a platform by name.
 */
type ConnectProvider = {
  label: string;
  /** Whether an account is kept per language. X publishes as one account. */
  perLocale: boolean;
  /** What is missing before this can be started, by setting name. */
  missing: (config: BackendConfig, locale: VideoLocale) => string[];
} & (
  | { kind: "redirect"; link: (config: BackendConfig, locale: VideoLocale, now: Date) => string }
  | {
      kind: "device";
      start: (config: BackendConfig, backendDb: BackendDb, locale: VideoLocale, fetchImpl: typeof fetch, now: Date) => Promise<DeviceStart>;
    }
);

type DeviceStart = { verificationUrl: string; userCode: string; expiresInSeconds: number };

export type ConnectStart =
  | { platform: ConnectPlatform; locale: VideoLocale | null; kind: "redirect"; url: string; expiresInMinutes: number }
  | {
      platform: ConnectPlatform;
      locale: VideoLocale | null;
      kind: "device";
      verificationUrl: string;
      userCode: string;
      expiresInSeconds: number;
    };

const CONNECT_PROVIDERS: Record<ConnectPlatform, ConnectProvider> = {
  threads: metaConnectProvider("threads"),
  instagram: metaConnectProvider("instagram"),
  x: {
    kind: "redirect",
    label: "X",
    perLocale: false,
    missing: (config) => missingSettings(config, ["X_CLIENT_ID", "X_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"]),
    // X's own start route is guarded for the dashboard, so what an interface
    // hands over is the platform's link, which already carries a sealed state.
    link: (config, _locale, now) => xOauthAuthorizeUrl(config, now),
  },
  youtube: {
    kind: "device",
    label: "YouTube",
    perLocale: true,
    missing: (config, locale) => {
      const suffix = locale === "en" ? "EN" : "RU";
      const credentials = youtubeCredentials(config, locale);
      return [
        credentials.clientId ? null : `YOUTUBE_${suffix}_CLIENT_ID`,
        credentials.clientSecret ? null : `YOUTUBE_${suffix}_CLIENT_SECRET`,
        config.TOKEN_ENCRYPTION_KEY ? null : "TOKEN_ENCRYPTION_KEY",
      ].filter((name): name is string => name !== null);
    },
    start: startYouTubeDevice,
  },
};

/**
 * Starts connecting an account and returns what the operator has to do next.
 *
 * The dashboard, the bot and the CLI all call this and show what comes back, so
 * connecting is the same act everywhere and a new platform reaches every
 * surface by being added to the table above.
 */
export async function startConnect(
  config: BackendConfig,
  backendDb: BackendDb,
  platform: ConnectPlatform,
  locale: VideoLocale,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<ConnectStart> {
  const provider = CONNECT_PROVIDERS[platform];
  const missing = provider.missing(config, locale);
  if (missing.length) throw new Error(`${provider.label} is not configured: ${missing.join(", ")}`);
  const at = provider.perLocale ? locale : null;
  if (provider.kind === "redirect")
    return { platform, locale: at, kind: "redirect", url: provider.link(config, locale, now), expiresInMinutes: LINK_TTL_MINUTES };
  return { platform, locale: at, kind: "device", ...(await provider.start(config, backendDb, locale, fetchImpl, now)) };
}

function metaConnectProvider(platform: MetaOauthPlatform): ConnectProvider {
  const meta = META_PROVIDERS[platform];
  return {
    kind: "redirect",
    label: meta.label,
    perLocale: true,
    missing: (config) =>
      [
        meta.appId(config) ? null : meta.appIdName,
        meta.appSecret(config) ? null : meta.appSecretName,
        config.TOKEN_ENCRYPTION_KEY ? null : "TOKEN_ENCRYPTION_KEY",
      ].filter((name): name is string => name !== null),
    link: (config, locale, now) => metaOauthConnectUrl(config, platform, locale, now),
  };
}

function missingSettings(config: BackendConfig, names: readonly string[]): string[] {
  const values = config as unknown as Record<string, unknown>;
  return names.filter((name) => !values[name]);
}

/** Asks Google for the code the operator types, and keeps the half that
 * redeems it until the credentials worker sees the approval. */
async function startYouTubeDevice(
  config: BackendConfig,
  backendDb: BackendDb,
  locale: VideoLocale,
  fetchImpl: typeof fetch,
  now: Date,
): Promise<DeviceStart> {
  const key = encryptionKey(config.TOKEN_ENCRYPTION_KEY);
  if (!key) throw new Error("TOKEN_ENCRYPTION_KEY is required to connect an account");
  const { clientId } = youtubeCredentials(config, locale);
  const device = await requestJson<{
    device_code?: string;
    user_code?: string;
    verification_url?: string;
    interval?: number;
    expires_in?: number;
  }>(fetchImpl, DEVICE_CODE_URL, { method: "POST", body: formBody({ client_id: clientId ?? "", scope: YOUTUBE_SCOPE }) });
  if (!device.device_code || !device.user_code || !device.verification_url) throw new Error("Google returned no device code");
  const expiresInSeconds = device.expires_in ?? 1800;
  const row = {
    sealedDeviceCode: seal(device.device_code, key),
    userCode: device.user_code,
    verificationUrl: device.verification_url,
    intervalSeconds: device.interval ?? 5,
    expiresAt: new Date(now.getTime() + expiresInSeconds * 1000).toISOString(),
    updatedAt: now.toISOString(),
  };
  unsafeDb(backendDb)
    .db.insert(deviceAuthorizations)
    .values({ target: youtubeTokenTarget(locale), ...row, createdAt: now.toISOString() })
    .onConflictDoUpdate({ target: deviceAuthorizations.target, set: row })
    .run();
  return { verificationUrl: device.verification_url, userCode: device.user_code, expiresInSeconds };
}

function pendingDeviceAuthorizations(backendDb: BackendDb): (typeof deviceAuthorizations.$inferSelect)[] {
  return unsafeDb(backendDb).db.select().from(deviceAuthorizations).all();
}

function forgetDeviceAuthorization(backendDb: BackendDb, target: string): void {
  unsafeDb(backendDb).db.delete(deviceAuthorizations).where(eq(deviceAuthorizations.target, target)).run();
}

/**
 * Finishes every device authorization the operator has approved.
 *
 * Google answers a device flow by being polled, and the credentials worker is
 * where that belongs: an operator who started the connection from a chat, a
 * terminal or an agent has nothing left to hold open, and the approval lands in
 * the same place regardless of which surface began it.
 */
export async function redeemDeviceAuthorizations(
  config: BackendConfig,
  backendDb: BackendDb,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<number> {
  const key = encryptionKey(config.TOKEN_ENCRYPTION_KEY);
  if (!key) return 0;
  let connected = 0;
  for (const pending of pendingDeviceAuthorizations(backendDb)) {
    const locale: VideoLocale = pending.target.endsWith("_en") ? "en" : "ru";
    if (new Date(pending.expiresAt).getTime() <= now.getTime()) {
      forgetDeviceAuthorization(backendDb, pending.target);
      log("warn", "device authorization expired before it was approved", { target: pending.target });
      continue;
    }
    const { clientId, clientSecret } = youtubeCredentials(config, locale);
    const answer = await requestJson<{ refresh_token?: string; error?: string }>(fetchImpl, YOUTUBE_TOKEN_URL, {
      method: "POST",
      body: formBody({
        client_id: clientId ?? "",
        client_secret: clientSecret ?? "",
        device_code: open(pending.sealedDeviceCode, key),
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    }).catch((error: unknown) => ({ error: String(error) }) as { refresh_token?: string; error?: string });
    // Still waiting for the operator to approve, which is the ordinary answer.
    if (answer.error && (answer.error.includes("authorization_pending") || answer.error.includes("slow_down"))) continue;
    if (!answer.refresh_token) {
      forgetDeviceAuthorization(backendDb, pending.target);
      log("warn", "device authorization was refused", { target: pending.target, error: answer.error ?? "no refresh token" });
      continue;
    }
    installYouTubeToken(config, backendDb, locale, answer.refresh_token, now);
    registerChannel(backendDb, { platform: "youtube", locale, provider: "native", source: "interface" });
    forgetDeviceAuthorization(backendDb, pending.target);
    connected += 1;
    log("info", "YouTube channel connected", { target: pending.target });
  }
  return connected;
}
