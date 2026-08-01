import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { channelCredentials } from "../db/schema.js";
import type { VideoLocale } from "../publishing/video-types.js";

/**
 * Secrets that belong to a channel rather than to the deployment.
 *
 * Credentials used to live only in the container's environment, which is why a
 * natively connected account could not be added from any interface: there was
 * nowhere to put its token without a redeploy. A row here is the missing half of
 * a `channel_connections` row — the connection says which account, this says
 * what it takes to reach it.
 *
 * Values are encrypted at rest. A dashboard token or a database backup should
 * not hand over a publishing account, and these secrets are long-lived: a
 * YouTube refresh token stays valid until it is revoked by hand.
 */

/** The credential names each provider needs, and the environment variables the
 * same values occupy while a Studio has not migrated its channel yet. */
const CREDENTIAL_SHAPES: Record<string, Record<string, { ru: string; en: string }>> = {
  "youtube:native": {
    clientId: { ru: "YOUTUBE_CLIENT_ID", en: "YOUTUBE_EN_CLIENT_ID" },
    clientSecret: { ru: "YOUTUBE_CLIENT_SECRET", en: "YOUTUBE_EN_CLIENT_SECRET" },
    refreshToken: { ru: "YOUTUBE_REFRESH_TOKEN", en: "YOUTUBE_EN_REFRESH_TOKEN" },
  },
  "instagram:native": {
    accessToken: { ru: "INSTAGRAM_RU_ACCESS_TOKEN", en: "INSTAGRAM_EN_ACCESS_TOKEN" },
    userId: { ru: "INSTAGRAM_RU_USER_ID", en: "INSTAGRAM_EN_USER_ID" },
  },
  "instagram:zernio": { apiKey: { ru: "ZERNIO_API_KEY", en: "ZERNIO_API_KEY" } },
  "youtube:zernio": { apiKey: { ru: "ZERNIO_API_KEY", en: "ZERNIO_API_KEY" } },
};

export type CredentialShape = { name: string; envVariable: string }[];

/** What a channel of this platform and provider has to be given. An empty list
 * means the provider needs nothing beyond the account id on the connection. */
export function credentialShape(platform: string, provider: string, locale: VideoLocale): CredentialShape {
  const shape = CREDENTIAL_SHAPES[`${platform}:${provider}`];
  if (!shape) return [];
  return Object.entries(shape).map(([name, variables]) => ({ name, envVariable: variables[locale] }));
}

/** Environment-variable overrides carrying a channel's stored credentials, so a
 * connection that has them stops depending on the deployment's variables. */
export function credentialEnvironment(
  backendDb: BackendDb,
  secretKey: string | undefined,
  channel: { id: string; platform: string; provider: string; locale: string },
): Record<string, string> {
  const locale: VideoLocale = channel.locale === "en" ? "en" : "ru";
  const stored = channelSecrets(backendDb, secretKey, channel.id);
  const overrides: Record<string, string> = {};
  for (const { name, envVariable } of credentialShape(channel.platform, channel.provider, locale)) {
    const value = stored[name];
    if (value) overrides[envVariable] = value;
  }
  return overrides;
}

export function channelSecrets(backendDb: BackendDb, secretKey: string | undefined, channelId: string): Record<string, string> {
  const rows = backendDb.db.select().from(channelCredentials).where(eq(channelCredentials.channelId, channelId)).all();
  if (!rows.length) return {};
  const key = encryptionKey(secretKey);
  return Object.fromEntries(rows.map((row) => [row.name, decryptSecret(row.valueEncrypted, key)]));
}

export function setChannelSecrets(
  backendDb: BackendDb,
  secretKey: string | undefined,
  channelId: string,
  values: Record<string, string>,
): string[] {
  const key = encryptionKey(secretKey);
  const now = new Date().toISOString();
  const written: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (!value) continue;
    backendDb.db
      .insert(channelCredentials)
      .values({ channelId, name, valueEncrypted: encryptSecret(value, key), updatedAt: now })
      .onConflictDoUpdate({
        target: [channelCredentials.channelId, channelCredentials.name],
        set: { valueEncrypted: encryptSecret(value, key), updatedAt: now },
      })
      .run();
    written.push(name);
  }
  return written;
}

export function deleteChannelSecrets(backendDb: BackendDb, channelId: string, name?: string): void {
  const where = name
    ? and(eq(channelCredentials.channelId, channelId), eq(channelCredentials.name, name))
    : eq(channelCredentials.channelId, channelId);
  backendDb.db.delete(channelCredentials).where(where).run();
}

/** Names only — a caller that wants to report configuration state must never be
 * able to leak the values by accident. */
export function storedCredentialNames(backendDb: BackendDb, channelId: string): string[] {
  return backendDb.db
    .select({ name: channelCredentials.name })
    .from(channelCredentials)
    .where(eq(channelCredentials.channelId, channelId))
    .all()
    .map((row) => row.name);
}

/** Any passphrase is accepted and hashed to the required length: the operator
 * picks a secret, not a 32-byte buffer. */
function encryptionKey(secretKey: string | undefined): Buffer {
  if (!secretKey) throw new Error("CHANNEL_SECRET_KEY is required to store or read channel credentials");
  return createHash("sha256").update(secretKey).digest();
}

function encryptSecret(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}

function decryptSecret(payload: string, key: Buffer): string {
  const [iv, authTag, encrypted] = payload.split(".");
  if (!iv || !authTag || !encrypted) throw new Error("Stored channel credential is malformed");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
}
