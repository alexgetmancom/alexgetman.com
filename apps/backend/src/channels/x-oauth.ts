import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { platformTokens } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { formBody, requestJson } from "../foundation/http.js";
import { encryptionKey, open, seal } from "../foundation/secret-box.js";

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_AHEAD_MS = 10 * 60 * 1000;
const SCOPES = "tweet.read tweet.write users.read media.write offline.access";

type XState = { verifier: string; expiresAt: number; nonce: string };
type XTokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number };

export function xOauthConnectPath(config: BackendConfig): string {
  assertConfigured(config);
  return "/oauth/x/start";
}

export function xOauthConnectUrl(config: BackendConfig): string {
  return `${config.PUBLIC_BASE_URL.replace(/\/$/, "")}${xOauthConnectPath(config)}`;
}

export function xOauthAuthorizeUrl(config: BackendConfig, now = new Date()): string {
  assertConfigured(config);
  const key = requiredKey(config);
  const verifier = randomBytes(32).toString("base64url");
  const state = seal(JSON.stringify({ verifier, expiresAt: now.getTime() + STATE_TTL_MS, nonce: randomBytes(16).toString("hex") }), key);
  const query = new URLSearchParams({
    response_type: "code",
    client_id: required(config.X_CLIENT_ID, "X_CLIENT_ID"),
    redirect_uri: xOauthRedirectUri(config),
    scope: SCOPES,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${query}`;
}

export async function exchangeXCode(
  config: BackendConfig,
  backendDb: BackendDb,
  code: string,
  state: string,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<{ id: string; username: string }> {
  const parsed = readState(config, state, now);
  const tokens = await tokenRequest(
    config,
    formBody({
      grant_type: "authorization_code",
      code,
      redirect_uri: xOauthRedirectUri(config),
      code_verifier: parsed.verifier,
    }),
    fetchImpl,
  );
  installXTokens(config, backendDb, tokens, now);
  const profile = await requestJson<{ data?: { id?: string; username?: string } }>(fetchImpl, "https://api.x.com/2/users/me", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const id = profile.data?.id;
  if (!id) throw new Error("X returned no account id");
  unsafeDb(backendDb).db.update(platformTokens).set({ accountId: id }).where(eq(platformTokens.target, "x")).run();
  return { id, username: profile.data?.username?.trim() ?? "" };
}

export function applyStoredXTokens(config: BackendConfig, backendDb: BackendDb): void {
  const key = encryptionKey(config.TOKEN_ENCRYPTION_KEY);
  if (!key) return;
  const row = unsafeDb(backendDb).db.select().from(platformTokens).where(eq(platformTokens.target, "x")).get();
  if (!row?.sealedRefreshToken) return;
  const mutable = config as unknown as Record<string, unknown>;
  mutable.X_ACCESS_TOKEN = open(row.sealedToken, key);
  mutable.X_REFRESH_TOKEN = open(row.sealedRefreshToken, key);
}

export async function refreshXToken(
  config: BackendConfig,
  backendDb: BackendDb,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<"fresh" | "refreshed" | "unconfigured"> {
  if (!config.X_CLIENT_ID || !config.X_CLIENT_SECRET || !config.X_REFRESH_TOKEN) return "unconfigured";
  const row = unsafeDb(backendDb).db.select().from(platformTokens).where(eq(platformTokens.target, "x")).get();
  if (row?.expiresAt && new Date(row.expiresAt).getTime() - now.getTime() > REFRESH_AHEAD_MS) return "fresh";
  const tokens = await tokenRequest(config, formBody({ grant_type: "refresh_token", refresh_token: config.X_REFRESH_TOKEN }), fetchImpl);
  installXTokens(config, backendDb, tokens, now);
  return "refreshed";
}

function xOauthRedirectUri(config: BackendConfig): string {
  return `${config.PUBLIC_BASE_URL.replace(/\/$/, "")}/oauth/x`;
}

function readState(config: BackendConfig, state: string, now: Date): XState {
  let parsed: Partial<XState>;
  try {
    parsed = JSON.parse(open(state, requiredKey(config))) as Partial<XState>;
  } catch {
    throw new Error("X OAuth state is invalid");
  }
  if (!parsed.verifier || !parsed.nonce || !parsed.expiresAt || parsed.expiresAt < now.getTime())
    throw new Error("X OAuth link has expired");
  return parsed as XState;
}

function installXTokens(config: BackendConfig, backendDb: BackendDb, tokens: XTokenResponse, now: Date): void {
  if (!tokens.access_token || !tokens.refresh_token) throw new Error("X returned no renewable token pair");
  const key = requiredKey(config);
  const expiresAt = new Date(now.getTime() + (tokens.expires_in ?? 7200) * 1000).toISOString();
  unsafeDb(backendDb)
    .db.insert(platformTokens)
    .values({
      target: "x",
      sealedToken: seal(tokens.access_token, key),
      sealedRefreshToken: seal(tokens.refresh_token, key),
      seedFingerprint: null,
      accountId: null,
      expiresAt,
      refreshedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    })
    .onConflictDoUpdate({
      target: platformTokens.target,
      set: {
        sealedToken: seal(tokens.access_token, key),
        sealedRefreshToken: seal(tokens.refresh_token, key),
        expiresAt,
        refreshedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    })
    .run();
  const mutable = config as unknown as Record<string, unknown>;
  mutable.X_ACCESS_TOKEN = tokens.access_token;
  mutable.X_REFRESH_TOKEN = tokens.refresh_token;
}

async function tokenRequest(config: BackendConfig, body: URLSearchParams, fetchImpl: typeof fetch): Promise<XTokenResponse> {
  const clientId = required(config.X_CLIENT_ID, "X_CLIENT_ID");
  const clientSecret = required(config.X_CLIENT_SECRET, "X_CLIENT_SECRET");
  return requestJson<XTokenResponse>(fetchImpl, TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body,
  });
}

function assertConfigured(config: BackendConfig): void {
  required(config.X_CLIENT_ID, "X_CLIENT_ID");
  required(config.X_CLIENT_SECRET, "X_CLIENT_SECRET");
  requiredKey(config);
}

function requiredKey(config: BackendConfig): Buffer {
  const key = encryptionKey(config.TOKEN_ENCRYPTION_KEY);
  if (!key) throw new Error("TOKEN_ENCRYPTION_KEY is required for browser OAuth");
  return key;
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required for browser OAuth`);
  return value.trim();
}
