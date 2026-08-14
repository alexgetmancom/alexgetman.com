import {
  exchangeInstagramCode,
  exchangeThreadsCode,
  type MetaOauthPlatform,
  metaOauthAuthorizeUrl,
  metaOauthConnectUrl,
  verifyMetaOauthState,
} from "../../channels/meta-oauth.js";
import { installMetaToken } from "../../channels/meta-tokens.js";
import { escapeHtml } from "../../foundation/html.js";
import { requestJson } from "../../foundation/http.js";
import { commandAllowed } from "../../foundation/http-auth.js";
import type { RouteModule } from "./context.js";

export const metaOauthRoutes: RouteModule = (app, { config, backendDb, studio }) => {
  for (const platform of ["threads", "instagram"] as const) {
    app.get(`/oauth/${platform}/start`, (c) => {
      try {
        let state = c.req.query("state") ?? "";
        if (!state) {
          if (!commandAllowed(c.req.raw, config)) throw new Error("Open this link from an authenticated Command Center");
          const locale = c.req.query("locale");
          if (locale !== "ru" && locale !== "en") throw new Error("OAuth link has no valid locale");
          state = new URL(metaOauthConnectUrl(config, platform, locale)).searchParams.get("state") ?? "";
        }
        const parsed = verifyMetaOauthState(config, state);
        if (parsed.platform !== platform) throw new Error("OAuth link names a different platform");
        return new Response(null, {
          status: 302,
          headers: { location: metaOauthAuthorizeUrl(config, state), "cache-control": "no-store" },
        });
      } catch (error) {
        return oauthPage("Connection link is invalid", String(error), 400);
      }
    });

    app.get(`/oauth/${platform}`, async (c) => {
      try {
        const state = c.req.query("state") ?? "";
        const parsed = verifyMetaOauthState(config, state);
        if (parsed.platform !== platform) throw new Error("OAuth callback reached the wrong platform route");
        const refused = c.req.query("error_description") ?? c.req.query("error");
        if (refused) throw new Error(`${displayPlatform(platform)} refused the authorization: ${refused}`);
        const code = c.req.query("code");
        if (!code) throw new Error("OAuth callback has no code");
        const identity = await exchangeAndInstall(platform, parsed.locale, code, config, backendDb);
        connectNativeRoutes(studio.channels, platform, parsed.locale, identity.userId, identity.username);
        return oauthPage(
          `${displayPlatform(platform)} connected`,
          `${identity.username ? `@${identity.username}` : identity.userId} is ready for ${parsed.locale.toUpperCase()} publishing.`,
          200,
        );
      } catch (error) {
        return oauthPage(`${displayPlatform(platform)} connection failed`, String(error), 400);
      }
    });
  }
};

async function exchangeAndInstall(
  platform: MetaOauthPlatform,
  locale: "ru" | "en",
  code: string,
  config: Parameters<typeof installMetaToken>[0],
  backendDb: Parameters<typeof installMetaToken>[1],
): Promise<{ userId: string; username: string }> {
  if (platform === "instagram") {
    const authorization = await exchangeInstagramCode(config, code);
    installMetaToken(config, backendDb, `instagram_${locale}`, authorization.accessToken, authorization.userId);
    return authorization;
  }
  const authorization = await exchangeThreadsCode(config, code);
  if (!authorization.userId) throw new Error("Threads returned no account id");
  const profile = await requestJson<{ id?: string | number; username?: string }>(
    fetch,
    `https://graph.threads.net/v1.0/me?fields=id,username&access_token=${encodeURIComponent(authorization.accessToken)}`,
  );
  const userId = String(profile.id ?? authorization.userId);
  installMetaToken(config, backendDb, `threads_${locale}`, authorization.accessToken, userId);
  return { userId, username: profile.username?.trim() ?? "" };
}

function connectNativeRoutes(
  channels: {
    connect: (input: {
      platform: string;
      locale: "ru" | "en";
      provider: string;
      providerAccountId?: string;
      targetId?: string;
      label?: string;
    }) => unknown;
  },
  platform: MetaOauthPlatform,
  locale: "ru" | "en",
  accountId: string,
  username: string,
): void {
  const account = username ? `@${username}` : accountId;
  if (platform === "threads") {
    const targetId = `threads_${locale}`;
    channels.connect({
      platform: targetId,
      locale,
      provider: "native",
      providerAccountId: accountId,
      targetId,
      label: `Threads ${locale.toUpperCase()} · ${account}`,
    });
    return;
  }
  channels.connect({
    platform: "instagram",
    locale,
    provider: "native",
    providerAccountId: accountId,
    label: `Instagram ${locale.toUpperCase()} · ${account}`,
  });
  const targetId = locale === "ru" ? "instagram_stories_ru" : "instagram_stories";
  channels.connect({
    platform: targetId,
    locale,
    provider: "native",
    providerAccountId: accountId,
    targetId,
    label: `Instagram Stories ${locale.toUpperCase()} · ${account}`,
  });
}

function oauthPage(title: string, message: string, status: number): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/command-center?tab=studio">Return to Studio</a></p></main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } },
  );
}

function displayPlatform(platform: MetaOauthPlatform): string {
  return platform === "threads" ? "Threads" : "Instagram";
}
