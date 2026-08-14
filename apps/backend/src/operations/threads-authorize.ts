import { exchangeThreadsCode, metaOauthRedirectUri, threadsAuthorizeUrl } from "../channels/meta-oauth.js";
import type { BackendConfig } from "../foundation/config.js";
import type { VideoLocale } from "../publishing/video-types.js";

/**
 * Obtains the long-lived Threads token this Studio publishes with.
 *
 * The application renews a token it already has; producing the first one was
 * three curl calls the operator ran by hand, and the day one lapsed that was
 * the whole recovery procedure.
 *
 * Kept as the terminal fallback for a Studio whose Command Center is not
 * reachable. The normal path is the browser callback, which performs the same
 * exchange and stores the credential without copying a URL or restarting.
 *
 * The code is single-use and lives an hour, which is why this exchanges it for
 * a long-lived token immediately rather than handing back something the
 * operator has to spend again.
 */
export type ThreadsAuthorization = {
  locale: VideoLocale;
  variable: string;
  accessToken: string;
  userId: string;
  note: string;
};

/** The redirect Meta sends the operator to. It must match the app dashboard
 * exactly, so it is derived from one setting rather than configured twice. */
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

  const redirectUri = metaOauthRedirectUri(config, "threads");
  options.onPrompt?.(threadsAuthorizeUrl(config, appId), redirectUri);

  const code = authorizationCode(await askForRedirect());
  const authorization = await exchangeThreadsCode(config, code, fetchImpl);

  const suffix = locale === "en" ? "EN" : "RU";
  return {
    locale,
    variable: `THREADS_${suffix}_ACCESS_TOKEN`,
    accessToken: authorization.accessToken,
    userId: authorization.userId,
    note: "Terminal fallback: put this in .env and restart. The normal browser callback stores and activates it automatically.",
  };
}
