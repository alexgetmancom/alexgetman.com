import { describe, expect, it } from "bun:test";
import { applyStoredMetaTokens, installMetaToken, renewMetaTokens } from "../src/channels/meta-tokens.js";
import { loadConfig } from "../src/foundation/config.js";
import { withDb } from "./helpers/db.js";

const KEY = "ab".repeat(32);
const base = { TOKEN_ENCRYPTION_KEY: KEY, THREADS_RU_ACCESS_TOKEN: "seed-token" };

function renewer(replies: Record<string, string>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const token = Object.entries(replies).find(([needle]) => url.includes(needle))?.[1];
    if (!token) return new Response("{}", { status: 400 });
    return new Response(JSON.stringify({ access_token: token }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const longAgo = new Date("2026-01-01T00:00:00.000Z");
const later = new Date("2026-03-01T00:00:00.000Z");

describe("meta token renewal", () => {
  it("renews a token that is old enough and serves the renewal from then on", () =>
    withDb(async (backendDb) => {
      // Meta renews by issuing a new token, so the renewal has to be stored: the
      // .env file is the host's and read-only.
      const config = loadConfig(base);
      const { fetchImpl } = renewer({ "graph.threads.net": "renewed-token" });

      expect(await renewMetaTokens(config, backendDb, fetchImpl, longAgo)).toContainEqual({ target: "threads_ru", status: "renewed" });
      // The process keeps one name for the effective credential.
      expect(config.THREADS_RU_ACCESS_TOKEN).toBe("renewed-token");

      // A fresh process reads it back out of the database.
      const restarted = loadConfig(base);
      applyStoredMetaTokens(restarted, backendDb);
      expect(restarted.THREADS_RU_ACCESS_TOKEN).toBe("renewed-token");
    }));

  it("leaves a recently renewed token alone", () =>
    withDb(async (backendDb) => {
      const config = loadConfig(base);
      const { fetchImpl, calls } = renewer({ "graph.threads.net": "renewed-token" });
      await renewMetaTokens(config, backendDb, fetchImpl, longAgo);
      const after = calls.length;

      // A day later there is nothing to do: renewal happens far from expiry, not
      // on every tick.
      expect(await renewMetaTokens(config, backendDb, fetchImpl, new Date(longAgo.getTime() + 86_400_000))).toContainEqual({
        target: "threads_ru",
        status: "fresh",
      });
      expect(calls).toHaveLength(after);
    }));

  it("gives way to a token the operator replaced by hand", () =>
    withDb(async (backendDb) => {
      // A Studio switched off for two months comes back with a token Meta will
      // no longer renew, and the human puts a new one in .env. That is newer
      // intent than anything stored, and the stored one must not win.
      const config = loadConfig(base);
      const { fetchImpl } = renewer({ "graph.threads.net": "renewed-token" });
      await renewMetaTokens(config, backendDb, fetchImpl, longAgo);

      const replaced = loadConfig({ ...base, THREADS_RU_ACCESS_TOKEN: "hand-issued-token" });
      applyStoredMetaTokens(replaced, backendDb);
      expect(replaced.THREADS_RU_ACCESS_TOKEN).toBe("hand-issued-token");
    }));

  it("does nothing at all without a key to seal with", () =>
    withDb(async (backendDb) => {
      // Every install worked this way before the feature existed, and an install
      // that has not opted in keeps working exactly like that.
      const config = loadConfig({ THREADS_RU_ACCESS_TOKEN: "seed-token" });
      const { fetchImpl, calls } = renewer({ "graph.threads.net": "renewed-token" });

      expect(await renewMetaTokens(config, backendDb, fetchImpl, longAgo)).toEqual([]);
      expect(calls).toHaveLength(0);
      expect(config.THREADS_RU_ACCESS_TOKEN).toBe("seed-token");
    }));

  it("keeps the credential out of the backup in readable form", () =>
    withDb(async (backendDb) => {
      // This table travels in the daily backup to a chat.
      const config = loadConfig(base);
      const { fetchImpl } = renewer({ "graph.threads.net": "renewed-token" });
      await renewMetaTokens(config, backendDb, fetchImpl, longAgo);

      const rows = backendDb.sqlite.prepare("SELECT sealed_token FROM platform_tokens").all() as { sealed_token: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.sealed_token).not.toContain("renewed-token");
    }));

  it("loads a browser-issued token and Instagram account id without an env seed", () =>
    withDb((backendDb) => {
      const running = loadConfig({ TOKEN_ENCRYPTION_KEY: KEY });
      installMetaToken(running, backendDb, "instagram_ru", "oauth-token", "ig-42", longAgo);
      expect(running.INSTAGRAM_RU_ACCESS_TOKEN).toBe("oauth-token");
      expect(running.INSTAGRAM_RU_USER_ID).toBe("ig-42");

      const restarted = loadConfig({ TOKEN_ENCRYPTION_KEY: KEY });
      applyStoredMetaTokens(restarted, backendDb);
      expect(restarted.INSTAGRAM_RU_ACCESS_TOKEN).toBe("oauth-token");
      expect(restarted.INSTAGRAM_RU_USER_ID).toBe("ig-42");
      expect(
        backendDb.sqlite.prepare("SELECT seed_fingerprint AS seedFingerprint FROM platform_tokens WHERE target='instagram_ru'").get(),
      ).toEqual({ seedFingerprint: null });
    }));

  it("reports a refusal instead of silently leaving a dying token in place", () =>
    withDb(async (backendDb) => {
      const config = loadConfig(base);
      const { fetchImpl } = renewer({});

      expect(await renewMetaTokens(config, backendDb, fetchImpl, later)).toContainEqual({ target: "threads_ru", status: "failed" });
      expect(config.THREADS_RU_ACCESS_TOKEN).toBe("seed-token");
    }));
});
