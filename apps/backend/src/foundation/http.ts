export class ExternalHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

/** Reads Retry-After (seconds or HTTP-date) or X-RateLimit-Reset (unix seconds),
 * so a 429/503 retry waits exactly as long as the provider asked instead of
 * guessing with a fixed exponential backoff. */
export function retryAfterSecondsFromHeaders(headers: Headers): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds);
    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs)) return Math.max(0, Math.round((dateMs - Date.now()) / 1000));
  }
  const resetEpochSeconds = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(resetEpochSeconds) && resetEpochSeconds > 0) return Math.max(0, Math.round(resetEpochSeconds - Date.now() / 1000));
  return null;
}

export async function requestJson<T = Record<string, unknown>>(fetchImpl: typeof fetch, url: string, init: RequestInit = {}): Promise<T> {
  const response = await externalFetch(fetchImpl, url, init);
  const body = await response.text();
  if (!response.ok) {
    throw new ExternalHttpError(
      `${init.method ?? "GET"} ${safeUrl(url)} failed: ${response.status} ${redactExternalSecrets(body)}`,
      response.status,
      redactExternalSecrets(body),
      retryAfterSecondsFromHeaders(response.headers),
    );
  }
  if (!body) return {} as T;
  try {
    return JSON.parse(body) as T;
  } catch {
    // A proxy error page reaches here as HTML. Raising the raw SyntaxError would
    // put the unredacted body into logs, bypassing the redaction every other
    // failure path in this module goes through.
    throw new ExternalHttpError(
      `${init.method ?? "GET"} ${safeUrl(url)} returned a non-JSON body: ${redactExternalSecrets(body).slice(0, 200)}`,
      response.status,
      redactExternalSecrets(body),
    );
  }
}

export async function requestText(fetchImpl: typeof fetch, url: string, init: RequestInit = {}): Promise<string> {
  const response = await externalFetch(fetchImpl, url, init);
  const body = await response.text();
  if (!response.ok) {
    throw new ExternalHttpError(
      `${init.method ?? "GET"} ${safeUrl(url)} failed: ${response.status} ${redactExternalSecrets(body)}`,
      response.status,
      redactExternalSecrets(body),
      retryAfterSecondsFromHeaders(response.headers),
    );
  }
  return body;
}

export async function externalFetch(fetchImpl: typeof fetch, url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  // The 30s ceiling must hold even when the caller brings its own signal:
  // passing `init.signal` straight through used to leave that request with no
  // timeout at all while this timer aborted a controller nothing listened to.
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  try {
    return await fetchImpl(url, { ...init, signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${init.method ?? "GET"} ${safeUrl(url)} timed out after 30s`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

import { redactExternalSecrets } from "./redact.js";

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of ["access_token", "token", "api_key", "api-key", "password"]) {
      if (url.searchParams.has(key)) url.searchParams.set(key, "[REDACTED]");
    }
    url.pathname = url.pathname.replace(/\/bot[^/]+(?=\/|$)/, "/bot[REDACTED]");
    return url.toString();
  } catch {
    return redactExternalSecrets(value);
  }
}

export function formBody(fields: Record<string, string | number | boolean | null | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) continue;
    body.append(key, String(value));
  }
  return body;
}
