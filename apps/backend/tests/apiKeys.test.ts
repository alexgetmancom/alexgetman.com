import { describe, expect, it } from "bun:test";
import { applyStoredApiKeys, storeApiKey } from "../src/channels/api-keys.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const KEY = "ab".repeat(32);
const base = { TOKEN_ENCRYPTION_KEY: KEY };
const now = new Date("2026-08-15T20:00:00.000Z");

function transport(status = 200, body: unknown = { accounts: [{ _id: "one" }, { _id: "two" }] }) {
  const calls: { url: string; authorization: string | null }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization") });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("API keys the operator pastes", () => {
  it("verifies the key against the service, seals it, and reloads it after restart", () =>
    withDb(async (backendDb) => {
      const config = loadTestConfig(base);
      const { fetchImpl, calls } = transport();

      expect(await storeApiKey(config, backendDb, "zernio", "  zernio-key  ", fetchImpl, now)).toEqual({
        target: "zernio",
        account: "2 connected accounts",
      });
      // Trimmed before it is used, or a copy-pasted trailing newline reaches the
      // Authorization header of every later request.
      expect(calls).toEqual([{ url: "https://zernio.com/api/v1/accounts", authorization: "Bearer zernio-key" }]);
      expect(config.ZERNIO_API_KEY).toBe("zernio-key");

      const row = backendDb.sqlite.prepare("SELECT sealed_token AS sealed FROM platform_tokens WHERE target='zernio'").get() as {
        sealed: string;
      };
      expect(row.sealed).not.toContain("zernio-key");

      const restarted = loadTestConfig(base);
      applyStoredApiKeys(restarted, backendDb);
      expect(restarted.ZERNIO_API_KEY).toBe("zernio-key");
    }));

  it("stores a Discord bot token under the name the publisher reads", () =>
    withDb(async (backendDb) => {
      const config = loadTestConfig(base);
      const { fetchImpl, calls } = transport(200, { id: "9", username: "studio-bot" });

      expect(await storeApiKey(config, backendDb, "discord", "bot-token", fetchImpl, now)).toEqual({
        target: "discord",
        account: "studio-bot",
      });
      expect(calls[0]).toEqual({ url: "https://discord.com/api/v10/users/@me", authorization: "Bot bot-token" });

      const restarted = loadTestConfig(base);
      applyStoredApiKeys(restarted, backendDb);
      expect(restarted.DISCORD_BOT_TOKEN).toBe("bot-token");
    }));

  it("keeps a key the service rejects out of the database", () =>
    withDb(async (backendDb) => {
      const config = loadTestConfig(base);
      const { fetchImpl } = transport(401, { message: "401: Unauthorized" });

      await expect(storeApiKey(config, backendDb, "discord", "mistyped", fetchImpl, now)).rejects.toThrow();
      expect(backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM platform_tokens").get()).toEqual({ count: 0 });
      expect(config.DISCORD_BOT_TOKEN).toBeUndefined();
    }));

  it("ignores a key left behind in the environment", () => {
    const config = loadTestConfig({ ...base, ZERNIO_API_KEY: "z".repeat(16), DISCORD_BOT_TOKEN: "stale-env-token" });
    expect(config.ZERNIO_API_KEY).toBeUndefined();
    expect(config.DISCORD_BOT_TOKEN).toBeUndefined();
  });
});
