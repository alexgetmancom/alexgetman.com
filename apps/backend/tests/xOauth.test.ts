import { describe, expect, it } from "bun:test";
import { applyStoredXTokens, exchangeXCode, refreshXToken, xOauthAuthorizeUrl } from "../src/channels/x-oauth.js";
import { loadConfig } from "../src/foundation/config.js";
import { withDb } from "./helpers/db.js";

const KEY = "ef".repeat(32);
const now = new Date("2026-08-14T20:00:00.000Z");
const base = {
  PUBLIC_BASE_URL: "https://publisher.example.com",
  TOKEN_ENCRYPTION_KEY: KEY,
  X_CLIENT_ID: "x-client",
  X_CLIENT_SECRET: "x-secret",
};

describe("X browser OAuth", () => {
  it("creates an encrypted PKCE state and asks for renewable publishing access", () => {
    const authorization = new URL(xOauthAuthorizeUrl(loadConfig(base), now));
    expect(authorization.origin + authorization.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(authorization.searchParams.get("redirect_uri")).toBe("https://publisher.example.com/oauth/x");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("scope")?.split(" ")).toEqual([
      "tweet.read",
      "tweet.write",
      "users.read",
      "media.write",
      "offline.access",
    ]);
    expect(authorization.searchParams.get("state")).not.toContain("verifier");
  });

  it("exchanges the code, seals both tokens, and reloads them after restart", () =>
    withDb(async (backendDb) => {
      const config = loadConfig(base);
      const state = new URL(xOauthAuthorizeUrl(config, now)).searchParams.get("state") ?? "";
      const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/2/oauth2/token")) {
          expect(String(init?.body)).toContain("code_verifier=");
          expect(new Headers(init?.headers).get("Authorization")).toStartWith("Basic ");
          return Response.json({ access_token: "access-one", refresh_token: "refresh-one", expires_in: 7200 });
        }
        if (url.endsWith("/2/users/me")) return Response.json({ data: { id: "42", username: "publisher" } });
        return new Response("not found", { status: 404 });
      }) as typeof fetch;

      expect(await exchangeXCode(config, backendDb, "one-time-code", state, fetchImpl, now)).toEqual({
        id: "42",
        username: "publisher",
      });
      const row = backendDb.sqlite
        .prepare(
          "SELECT sealed_token AS access, sealed_refresh_token AS refresh, account_id AS accountId FROM platform_tokens WHERE target='x'",
        )
        .get() as { access: string; refresh: string; accountId: string };
      expect(row.access).not.toContain("access-one");
      expect(row.refresh).not.toContain("refresh-one");
      expect(row.accountId).toBe("42");

      const restarted = loadConfig(base);
      applyStoredXTokens(restarted, backendDb);
      expect(restarted.X_ACCESS_TOKEN).toBe("access-one");
      expect(restarted.X_REFRESH_TOKEN).toBe("refresh-one");
    }));

  it("rotates an expiring refresh token and persists the replacement", () =>
    withDb(async (backendDb) => {
      const config = loadConfig(base);
      const state = new URL(xOauthAuthorizeUrl(config, now)).searchParams.get("state") ?? "";
      let tokenCall = 0;
      const fetchImpl = (async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/2/oauth2/token")) {
          tokenCall += 1;
          return Response.json({ access_token: `access-${tokenCall}`, refresh_token: `refresh-${tokenCall}`, expires_in: 60 });
        }
        return Response.json({ data: { id: "42", username: "publisher" } });
      }) as typeof fetch;
      await exchangeXCode(config, backendDb, "code", state, fetchImpl, now);
      expect(await refreshXToken(config, backendDb, fetchImpl, new Date(now.getTime() + 61_000))).toBe("refreshed");
      expect(config.X_ACCESS_TOKEN).toBe("access-2");
      expect(config.X_REFRESH_TOKEN).toBe("refresh-2");
    }));
});
