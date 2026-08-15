import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { BackendConfig } from "../foundation/config.js";
import { formBody, requestJson } from "../foundation/http.js";
import { encryptionKey } from "../foundation/secret-box.js";
import type { VideoLocale } from "../publishing/video-types.js";

export type MetaOauthPlatform = "threads" | "instagram";
export type MetaOauthState = { platform: MetaOauthPlatform; locale: VideoLocale };

const STATE_TTL_MS = 10 * 60 * 1000;
const THREADS_AUTHORIZE_URL = "https://threads.net/oauth/authorize";
const THREADS_TOKEN_URL = "https://graph.threads.net/oauth/access_token";
const THREADS_EXCHANGE_URL = "https://graph.threads.net/access_token";
// Insights is not optional here: this Studio collects the metrics of what it
// publishes, and a token minted without it is accepted everywhere except the
// insights call, which fails for the life of the token.
const THREADS_SCOPE = "threads_basic,threads_content_publish,threads_manage_insights";
const INSTAGRAM_AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const INSTAGRAM_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const INSTAGRAM_EXCHANGE_URL = "https://graph.instagram.com/access_token";
const INSTAGRAM_PROFILE_URL = "https://graph.instagram.com/me";
const INSTAGRAM_SCOPE = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_insights",
  "instagram_business_manage_comments",
].join(",");

type StatePayload = MetaOauthState & { expiresAt: number; nonce: string };

export function metaOauthConnectUrl(config: BackendConfig, platform: MetaOauthPlatform, locale: VideoLocale, now = new Date()): string {
  assertConfigured(config, platform);
  const state = signState(config, {
    platform,
    locale,
    expiresAt: now.getTime() + STATE_TTL_MS,
    nonce: randomBytes(16).toString("base64url"),
  });
  return `${config.PUBLIC_BASE_URL.replace(/\/$/, "")}/oauth/${platform}/start?state=${encodeURIComponent(state)}`;
}

export function metaOauthConnectPath(config: BackendConfig, platform: MetaOauthPlatform, locale: VideoLocale): string {
  assertConfigured(config, platform);
  return `/oauth/${platform}/start?locale=${locale}`;
}

export function metaOauthAuthorizeUrl(config: BackendConfig, state: string, now = new Date()): string {
  const parsed = verifyMetaOauthState(config, state, now);
  if (parsed.platform === "threads") return threadsAuthorizeUrl(config, required(config.THREADS_APP_ID, "THREADS_APP_ID"), state);
  const query = new URLSearchParams({
    client_id: required(config.INSTAGRAM_APP_ID, "INSTAGRAM_APP_ID"),
    redirect_uri: metaOauthRedirectUri(config, "instagram"),
    response_type: "code",
    scope: INSTAGRAM_SCOPE,
    state,
    enable_fb_login: "0",
    force_reauth: "true",
  });
  return `${INSTAGRAM_AUTHORIZE_URL}?${query}`;
}

export function verifyMetaOauthState(config: BackendConfig, state: string, now = new Date()): MetaOauthState {
  const [encoded, signature] = state.split(".");
  if (!encoded || !signature) throw new Error("OAuth state is malformed");
  const expected = stateSignature(config, encoded);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer))
    throw new Error("OAuth state is invalid");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<StatePayload>;
  if ((payload.platform !== "threads" && payload.platform !== "instagram") || (payload.locale !== "ru" && payload.locale !== "en"))
    throw new Error("OAuth state has an invalid destination");
  if (typeof payload.expiresAt !== "number" || payload.expiresAt < now.getTime()) throw new Error("OAuth link has expired");
  if (typeof payload.nonce !== "string" || payload.nonce.length < 16) throw new Error("OAuth state has no nonce");
  return { platform: payload.platform, locale: payload.locale };
}

export function metaOauthRedirectUri(config: BackendConfig, platform: MetaOauthPlatform): string {
  return `${config.PUBLIC_BASE_URL.replace(/\/$/, "")}/oauth/${platform}`;
}

export function threadsAuthorizeUrl(config: BackendConfig, appId: string, state?: string): string {
  const query = new URLSearchParams({
    client_id: appId,
    redirect_uri: metaOauthRedirectUri(config, "threads"),
    scope: THREADS_SCOPE,
    response_type: "code",
  });
  if (state) query.set("state", state);
  return `${THREADS_AUTHORIZE_URL}?${query}`;
}

export async function exchangeThreadsCode(
  config: BackendConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; userId: string }> {
  const appId = required(config.THREADS_APP_ID, "THREADS_APP_ID");
  const appSecret = required(config.THREADS_APP_SECRET, "THREADS_APP_SECRET");
  const redirectUri = metaOauthRedirectUri(config, "threads");
  const shortLived = await requestJson<{ access_token?: string; user_id?: number | string }>(fetchImpl, THREADS_TOKEN_URL, {
    method: "POST",
    body: formBody({ client_id: appId, client_secret: appSecret, grant_type: "authorization_code", redirect_uri: redirectUri, code }),
  });
  if (!shortLived.access_token) throw new Error("Threads returned no access token for that code");
  const query = new URLSearchParams({ grant_type: "th_exchange_token", client_secret: appSecret, access_token: shortLived.access_token });
  const longLived = await requestJson<{ access_token?: string }>(fetchImpl, `${THREADS_EXCHANGE_URL}?${query}`);
  if (!longLived.access_token) throw new Error("Threads refused to issue a long-lived token");
  return { accessToken: longLived.access_token, userId: String(shortLived.user_id ?? "") };
}

export async function exchangeInstagramCode(
  config: BackendConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; userId: string; username: string }> {
  const appId = required(config.INSTAGRAM_APP_ID, "INSTAGRAM_APP_ID");
  const appSecret = required(config.INSTAGRAM_APP_SECRET, "INSTAGRAM_APP_SECRET");
  const shortLived = await requestJson<{ access_token?: string; user_id?: number | string }>(fetchImpl, INSTAGRAM_TOKEN_URL, {
    method: "POST",
    body: formBody({
      client_id: appId,
      client_secret: appSecret,
      grant_type: "authorization_code",
      redirect_uri: metaOauthRedirectUri(config, "instagram"),
      code,
    }),
  });
  if (!shortLived.access_token) throw new Error("Instagram returned no access token for that code");
  const exchange = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: appSecret,
    access_token: shortLived.access_token,
  });
  const longLived = await requestJson<{ access_token?: string }>(fetchImpl, `${INSTAGRAM_EXCHANGE_URL}?${exchange}`);
  if (!longLived.access_token) throw new Error("Instagram refused to issue a long-lived token");
  const profileQuery = new URLSearchParams({ fields: "id,username", access_token: longLived.access_token });
  const profile = await requestJson<{ id?: number | string; username?: string }>(fetchImpl, `${INSTAGRAM_PROFILE_URL}?${profileQuery}`);
  const userId = String(profile.id ?? shortLived.user_id ?? "");
  if (!userId) throw new Error("Instagram returned no account id");
  return { accessToken: longLived.access_token, userId, username: profile.username?.trim() ?? "" };
}

function signState(config: BackendConfig, payload: StatePayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${stateSignature(config, encoded)}`;
}

function stateSignature(config: BackendConfig, encoded: string): string {
  const key = encryptionKey(required(config.TOKEN_ENCRYPTION_KEY, "TOKEN_ENCRYPTION_KEY"));
  if (!key) throw new Error("TOKEN_ENCRYPTION_KEY is required for browser OAuth");
  return createHmac("sha256", key).update(encoded).digest("base64url");
}

function assertConfigured(config: BackendConfig, platform: MetaOauthPlatform): void {
  required(config.TOKEN_ENCRYPTION_KEY, "TOKEN_ENCRYPTION_KEY");
  if (platform === "threads") {
    required(config.THREADS_APP_ID, "THREADS_APP_ID");
    required(config.THREADS_APP_SECRET, "THREADS_APP_SECRET");
  } else {
    required(config.INSTAGRAM_APP_ID, "INSTAGRAM_APP_ID");
    required(config.INSTAGRAM_APP_SECRET, "INSTAGRAM_APP_SECRET");
  }
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required for browser OAuth`);
  return value.trim();
}
