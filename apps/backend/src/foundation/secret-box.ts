import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Encryption for credentials this Studio refreshes on its own.
 *
 * A platform token that the Studio renews cannot live in .env — the file is
 * mounted read-only and belongs to the host — so it is kept in the database.
 * The database leaves the machine every day as a backup, which is fine for
 * schedules and analytics and is not fine for a live access token, so what is
 * stored is a sealed value and the key stays in .env where the rest of the
 * secrets are.
 *
 * AES-256-GCM: the tag makes a tampered or truncated value fail loudly rather
 * than decrypt into something that looks like a token and is refused by the
 * platform hours later.
 */
const ALGORITHM = "aes-256-gcm";

export function encryptionKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const key = Buffer.from(raw.trim(), "hex");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes of hex — generate one with: openssl rand -hex 32");
  return key;
}

export function seal(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const sealed = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), sealed.toString("base64")].join(".");
}

export function open(sealed: string, key: Buffer): string {
  const [iv, tag, body] = sealed.split(".");
  if (!iv || !tag || !body) throw new Error("stored secret is not in the expected format");
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}

/** Identifies the .env value a stored token grew from, without keeping it.
 * When the operator puts a different token in .env — because the stored one
 * lapsed while the Studio was off — that is newer intent than anything the
 * database holds, and this is how the difference is noticed. */
export function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}
