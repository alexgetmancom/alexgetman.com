import type { BackendConfig } from "../foundation/config.js";
import { formBody, requestJson } from "../foundation/http.js";
import type { VideoLocale } from "../publishing/video-types.js";

/**
 * Obtains the long-lived Threads token this Studio publishes with.
 *
 * The application renews a token it already has; producing the first one was
 * three curl calls the operator ran by hand, and the day one lapsed that was
 * the whole recovery procedure.
 *
 * Threads has no device flow, so unlike YouTube this cannot be finished on
 * another device alone: Meta answers the consent screen with a redirect, and
 * the authorization code arrives in that URL. The redirect target deliberately
 * serves nothing — a Studio may not serve a site at all — so the browser lands
 * on an error page and the address bar is the payload. That is the one
 * awkwardness here, and it is Meta's shape, not a missing piece.
 *
 * The code is single-use and lives an hour, which is why this exchanges it for
 * a long-lived token immediately rather than handing back something the
 * operator has to spend again.
 */
const AUTHORIZE_URL = "https://threads.net/oauth/authorize";
const TOKEN_URL = "https://graph.threads.net/oauth/access_token";
const EXCHANGE_URL = "https://graph.threads.net/access_token";
/** Publishing needs both: `threads_basic` is required for every endpoint and
 * `threads_content_publish` for the ones that post. */
const SCOPE = "threads_basic,threads_content_publish";

export type ThreadsAuthorization = {
  locale: VideoLocale;
  variable: string;
  accessToken: string;
  userId: string;
  note: string;
};

/** The redirect Meta sends the operator to. It must match the app dashboard
 * exactly, so it is derived from one setting rather than configured twice. */
function threadsRedirectUri(config: BackendConfig): string {
  return `${config.PUBLIC_BASE_URL.replace(/\/$/, "")}/oauth/threads`;
}

export function threadsAuthorizeUrl(config: BackendConfig, appId: string): string {
  const query = new URLSearchParams({
    client_id: appId,
    redirect_uri: threadsRedirectUri(config),
    scope: SCOPE,
    response_type: "code",
  });
  return `${AUTHORIZE_URL}?${query}`;
}

/**
 * Takes whatever the operator copied out of the browser and returns the code.
 *
 * Pasting the entire address is the path of least effort and the one people
 * take, and Meta appends a literal `#_` to it that is not part of the code.
 * Both spellings are the same intent, so both are accepted.
 */
export function authorizationCode(pasted: string): string {
  const trimmed = pasted.trim().replace(/#_$/, "");
  if (!trimmed) throw new Error("Nothing was pasted. Approve the consent screen and copy the address it lands on.");
  if (!trimmed.includes("://")) return trimmed;

  const url = new URL(trimmed);
  const denied = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  // Cancelling redirects to the same place with an explanation, and reporting
  // "no code in that URL" for it would send the operator looking for a fault
  // that is not there.
  if (denied) throw new Error(`Threads refused the authorization: ${denied.replace(/\+/g, " ")}`);
  const code = url.searchParams.get("code");
  if (!code) throw new Error("That URL carries no code parameter. Copy the address the consent screen redirected to.");
  return code;
}

export async function authorizeThreads(
  config: BackendConfig,
  locale: VideoLocale,
  askForRedirect: () => Promise<string>,
  options: { fetchImpl?: typeof fetch; onPrompt?: (authorizeUrl: string, redirectUri: string) => void } = {},
): Promise<ThreadsAuthorization> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const appId = config.THREADS_APP_ID;
  const appSecret = config.THREADS_APP_SECRET;
  if (!appId || !appSecret)
    throw new Error(
      "Set THREADS_APP_ID and THREADS_APP_SECRET first. Both are in App Dashboard > App settings > Basic, under Threads App ID and Threads App secret — not the Meta app's own id and secret.",
    );

  const redirectUri = threadsRedirectUri(config);
  options.onPrompt?.(threadsAuthorizeUrl(config, appId), redirectUri);

  const code = authorizationCode(await askForRedirect());
  const shortLived = await requestJson<{ access_token?: string; user_id?: number | string }>(fetchImpl, TOKEN_URL, {
    method: "POST",
    body: formBody({ client_id: appId, client_secret: appSecret, grant_type: "authorization_code", redirect_uri: redirectUri, code }),
  });
  if (!shortLived.access_token)
    throw new Error("Threads returned no access token for that code. Codes are single-use and last an hour; start again.");

  const query = new URLSearchParams({ grant_type: "th_exchange_token", client_secret: appSecret, access_token: shortLived.access_token });
  const longLived = await requestJson<{ access_token?: string }>(fetchImpl, `${EXCHANGE_URL}?${query}`);
  if (!longLived.access_token) throw new Error("Threads issued a short-lived token but refused to exchange it for a long-lived one.");

  const suffix = locale === "en" ? "EN" : "RU";
  return {
    locale,
    variable: `THREADS_${suffix}_ACCESS_TOKEN`,
    accessToken: longLived.access_token,
    userId: String(shortLived.user_id ?? ""),
    note: "Put this in .env and restart. With TOKEN_ENCRYPTION_KEY set, this Studio renews it from here on.",
  };
}
