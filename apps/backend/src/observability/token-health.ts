import type { BackendDb } from "../db/client.js";
import { getBlueskySession } from "../delivery/social/bluesky.js";
import { recordDomainEvent } from "../domain/events.js";
import type { BackendConfig } from "../foundation/config.js";
import { oauthAuthorization } from "../foundation/external/x-oauth.js";
import { ExternalHttpError, requestJson } from "../foundation/http.js";
import { recordAuthFailure, recordAuthSuccess, recordTokenPing, shouldPingToken } from "./auth-circuit.js";

// A dead credential otherwise stays invisible until something tries to
// publish with it and burns part of the retry budget on a guaranteed 401.
// This probes each configured platform's cheapest "am I still authenticated"
// endpoint on its own cadence and feeds the result into the same auth circuit
// breaker publish failures use, so a token that died between posts is caught
// (and publishing paused) before the next real publish attempt.
const PING_INTERVAL_SECONDS = 60 * 60;
// Meta's debug_token tells us exactly when a Graph API token expires; warn
// once it's inside this window so a human can rotate it ahead of the failure
// instead of after a burst of dead publishes.
const EXPIRY_WARNING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type Probe = {
  target: string;
  configured: (config: BackendConfig) => boolean;
  /** Resolves to an ISO expiry timestamp when the provider can report one. */
  run: (config: BackendConfig, fetchImpl: typeof fetch) => Promise<string | null | void>;
};

function instagramHost(token: string): "graph.instagram.com" | "graph.facebook.com" {
  return token.startsWith("IG") ? "graph.instagram.com" : "graph.facebook.com";
}

/** Best-effort token expiry lookup; a failure here must not turn an otherwise
 * healthy probe into a reported auth failure. */
async function debugTokenExpiry(host: string, version: string, token: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const data = await requestJson<{ data?: { expires_at?: number } }>(
      fetchImpl,
      `https://${host}/${version}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`,
    );
    const expiresAtSeconds = data.data?.expires_at;
    return expiresAtSeconds ? new Date(expiresAtSeconds * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

async function graphMeCheck(host: string, version: string, id: string, token: string, fetchImpl: typeof fetch): Promise<string | null> {
  await requestJson(fetchImpl, `https://${host}/${version}/${id}?fields=id&access_token=${encodeURIComponent(token)}`);
  return debugTokenExpiry(host, version, token, fetchImpl);
}

const probes: Probe[] = [
  {
    target: "controller_bot",
    configured: (c) => Boolean(c.controllerBotToken),
    run: async (config, fetchImpl) => {
      await requestJson(fetchImpl, `${config.TELEGRAM_API_BASE_URL}/bot${config.controllerBotToken}/getMe`);
    },
  },
  {
    target: "x",
    configured: (c) => Boolean(c.X_CONSUMER_KEY && c.X_CONSUMER_SECRET && c.X_ACCESS_TOKEN && c.X_ACCESS_TOKEN_SECRET),
    run: async (config, fetchImpl) => {
      const url = "https://api.twitter.com/2/users/me";
      await requestJson(fetchImpl, url, { headers: { Authorization: oauthAuthorization("GET", url, config) } });
    },
  },
  {
    target: "github_en",
    configured: (c) => Boolean(c.GITHUB_DISCUSSIONS_TOKEN),
    run: async (config, fetchImpl) => {
      await requestJson(fetchImpl, "https://api.github.com/user", {
        headers: { Authorization: `Bearer ${config.GITHUB_DISCUSSIONS_TOKEN}`, "User-Agent": "alexgetman-posting" },
      });
    },
  },
  {
    // Same PAT as github_en; probed and recorded separately so each
    // discussion locale's status/circuit stays independently accurate.
    target: "github_ru",
    configured: (c) => Boolean(c.GITHUB_DISCUSSIONS_TOKEN),
    run: async (config, fetchImpl) => {
      await requestJson(fetchImpl, "https://api.github.com/user", {
        headers: { Authorization: `Bearer ${config.GITHUB_DISCUSSIONS_TOKEN}`, "User-Agent": "alexgetman-posting" },
      });
    },
  },
  {
    target: "devto",
    configured: (c) => Boolean(c.DEVTO_API_KEY),
    run: async (config, fetchImpl) => {
      await requestJson(fetchImpl, "https://dev.to/api/users/me", { headers: { "api-key": config.DEVTO_API_KEY as string } });
    },
  },
  {
    target: "mastodon",
    configured: (c) => Boolean(c.MASTODON_INSTANCE && c.MASTODON_ACCESS_TOKEN),
    run: async (config, fetchImpl) => {
      const base = `https://${(config.MASTODON_INSTANCE as string).replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
      await requestJson(fetchImpl, `${base}/api/v1/accounts/verify_credentials`, {
        headers: { Authorization: `Bearer ${config.MASTODON_ACCESS_TOKEN}` },
      });
    },
  },
  {
    target: "bluesky",
    configured: (c) => Boolean(c.BLUESKY_HANDLE && c.BLUESKY_APP_PASSWORD),
    run: async (config, fetchImpl) => {
      // Reuses the cached session (see bluesky.ts); only forces a fresh login
      // if the cache actually expired, so this doesn't reintroduce the
      // per-publish login the caching change removed.
      await getBlueskySession(config, fetchImpl);
    },
  },
  {
    target: "facebook",
    configured: (c) => Boolean(c.FACEBOOK_PAGE_ID && c.FACEBOOK_PAGE_ACCESS_TOKEN),
    run: (config, fetchImpl) =>
      graphMeCheck(
        "graph.facebook.com",
        config.FACEBOOK_GRAPH_API_VERSION,
        config.FACEBOOK_PAGE_ID as string,
        config.FACEBOOK_PAGE_ACCESS_TOKEN as string,
        fetchImpl,
      ),
  },
  {
    target: "facebook_ru",
    configured: (c) => Boolean(c.FACEBOOK_RU_PAGE_ID && c.FACEBOOK_RU_PAGE_ACCESS_TOKEN),
    run: (config, fetchImpl) =>
      graphMeCheck(
        "graph.facebook.com",
        config.FACEBOOK_GRAPH_API_VERSION,
        config.FACEBOOK_RU_PAGE_ID as string,
        config.FACEBOOK_RU_PAGE_ACCESS_TOKEN as string,
        fetchImpl,
      ),
  },
  {
    target: "threads_ru",
    configured: (c) => Boolean(c.THREADS_ACCESS_TOKEN),
    run: async (config, fetchImpl) => {
      await requestJson(
        fetchImpl,
        `https://graph.threads.net/v1.0/me?fields=id&access_token=${encodeURIComponent(config.THREADS_ACCESS_TOKEN as string)}`,
      );
    },
  },
  {
    target: "threads_en",
    configured: (c) => Boolean(c.THREADS_EN_ACCESS_TOKEN),
    run: async (config, fetchImpl) => {
      await requestJson(
        fetchImpl,
        `https://graph.threads.net/v1.0/me?fields=id&access_token=${encodeURIComponent(config.THREADS_EN_ACCESS_TOKEN as string)}`,
      );
    },
  },
  {
    target: "instagram_reels",
    configured: (c) => Boolean(c.INSTAGRAM_ACCESS_TOKEN && c.INSTAGRAM_USER_ID),
    run: (config, fetchImpl) => {
      const token = config.INSTAGRAM_ACCESS_TOKEN as string;
      const host = instagramHost(token);
      const version = host === "graph.instagram.com" ? config.INSTAGRAM_GRAPH_API_VERSION : config.FACEBOOK_GRAPH_API_VERSION;
      return graphMeCheck(host, version, config.INSTAGRAM_USER_ID as string, token, fetchImpl);
    },
  },
  {
    target: "instagram_stories",
    configured: (c) => Boolean(c.INSTAGRAM_EN_ACCESS_TOKEN && c.INSTAGRAM_EN_USER_ID),
    run: (config, fetchImpl) => {
      const token = config.INSTAGRAM_EN_ACCESS_TOKEN as string;
      const host = instagramHost(token);
      const version = host === "graph.instagram.com" ? config.INSTAGRAM_GRAPH_API_VERSION : config.FACEBOOK_GRAPH_API_VERSION;
      return graphMeCheck(host, version, config.INSTAGRAM_EN_USER_ID as string, token, fetchImpl);
    },
  },
  {
    target: "instagram_stories_ru",
    configured: (c) => Boolean(c.INSTAGRAM_RU_ACCESS_TOKEN && c.INSTAGRAM_RU_USER_ID),
    run: (config, fetchImpl) => {
      const token = config.INSTAGRAM_RU_ACCESS_TOKEN as string;
      const host = instagramHost(token);
      const version = host === "graph.instagram.com" ? config.INSTAGRAM_GRAPH_API_VERSION : config.FACEBOOK_GRAPH_API_VERSION;
      return graphMeCheck(host, version, config.INSTAGRAM_RU_USER_ID as string, token, fetchImpl);
    },
  },
];

/** Runs due live probes and feeds their outcome into the auth circuit
 * breaker/expiry alerts. Returns how many probes actually ran this cycle. */
export async function checkTokenHealth(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch = fetch): Promise<number> {
  let checked = 0;
  for (const probe of probes) {
    if (!probe.configured(config) || !shouldPingToken(backendDb, probe.target, PING_INTERVAL_SECONDS)) continue;
    checked += 1;
    try {
      const expiresAt = (await probe.run(config, fetchImpl)) ?? undefined;
      recordTokenPing(backendDb, probe.target, expiresAt);
      recordAuthSuccess(backendDb, probe.target);
      if (expiresAt && new Date(expiresAt).getTime() - Date.now() < EXPIRY_WARNING_WINDOW_MS) {
        recordDomainEvent(backendDb, {
          target: probe.target,
          type: "credential.token_expiring_soon",
          severity: "warn",
          message: `${probe.target}: access token expires ${expiresAt}; rotate it before it starts failing publishes`,
          details: { target: probe.target, expiresAt },
          cooldownSeconds: 24 * 60 * 60,
        });
      }
    } catch (error) {
      recordTokenPing(backendDb, probe.target);
      const status = error instanceof ExternalHttpError ? error.status : null;
      // Only 401/403 mean the credential itself is dead; a network hiccup or
      // an unrelated 5xx must not trip the breaker and pause real publishes.
      if (status === 401 || status === 403) recordAuthFailure(backendDb, probe.target);
    }
  }
  return checked;
}
