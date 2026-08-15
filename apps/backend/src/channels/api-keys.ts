import { eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { platformTokens } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { requestJson } from "../foundation/http.js";
import { log } from "../foundation/logger.js";
import { encryptionKey, open, seal } from "../foundation/secret-box.js";

/**
 * The services this Studio reaches with a key it is handed rather than one it
 * negotiates. There is no authorization to walk through and nothing that
 * expires, so the operator pastes the key once and it lives in the database
 * beside every other platform credential — .env has no say in it.
 */
const API_KEYS = {
  zernio: { setting: "ZERNIO_API_KEY", verify: verifyZernioKey },
  discord: { setting: "DISCORD_BOT_TOKEN", verify: verifyDiscordToken },
} as const;

export type ApiKeyTarget = keyof typeof API_KEYS;
export const API_KEY_TARGETS = Object.keys(API_KEYS) as ApiKeyTarget[];

/**
 * Puts each stored key under the name the rest of the process reads, the same
 * way the OAuth credentials arrive. Called once while the configuration is
 * built, so no caller learns where the value came from.
 */
export function applyStoredApiKeys(config: BackendConfig, backendDb: BackendDb): void {
  const key = encryptionKey(config.TOKEN_ENCRYPTION_KEY);
  if (!key) return;
  for (const target of API_KEY_TARGETS) {
    const row = unsafeDb(backendDb).db.select().from(platformTokens).where(eq(platformTokens.target, target)).get();
    if (!row) continue;
    try {
      config[API_KEYS[target].setting] = open(row.sealedToken, key);
    } catch (error) {
      log("warn", "stored API key could not be opened", { target, error: String(error) });
    }
  }
}

/**
 * Verifies the key against the service and stores it sealed. A key that the
 * service rejects is a paste error, and the moment to say so is now rather than
 * at the next publication.
 */
export async function storeApiKey(
  config: BackendConfig,
  backendDb: BackendDb,
  target: ApiKeyTarget,
  value: string,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<{ target: ApiKeyTarget; account: string }> {
  const key = encryptionKey(config.TOKEN_ENCRYPTION_KEY);
  if (!key) throw new Error("TOKEN_ENCRYPTION_KEY is required to store a credential");
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`no ${target} key was given`);
  const account = await API_KEYS[target].verify(trimmed, fetchImpl);
  const timestamp = now.toISOString();
  const row = {
    sealedToken: seal(trimmed, key),
    seedFingerprint: null,
    accountId: account,
    sealedRefreshToken: null,
    expiresAt: null,
    refreshedAt: timestamp,
    updatedAt: timestamp,
  };
  unsafeDb(backendDb)
    .db.insert(platformTokens)
    .values({ target, ...row })
    .onConflictDoUpdate({ target: platformTokens.target, set: row })
    .run();
  config[API_KEYS[target].setting] = trimmed;
  return { target, account };
}

async function verifyZernioKey(value: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await requestJson<{ accounts?: unknown[] } | unknown[]>(fetchImpl, "https://zernio.com/api/v1/accounts", {
    headers: { Authorization: `Bearer ${value}` },
  });
  const accounts = Array.isArray(response) ? response : (response.accounts ?? []);
  return `${accounts.length} connected accounts`;
}

async function verifyDiscordToken(value: string, fetchImpl: typeof fetch): Promise<string> {
  const bot = await requestJson<{ username?: string; id?: string }>(fetchImpl, "https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${value}` },
  });
  return bot.username ?? bot.id ?? "";
}
