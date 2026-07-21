const transientStatusCodes = new Set([408, 425, 429, 500, 502, 503, 504]);
// 401/403 are split out of the generic permanent bucket: they specifically mean
// "this credential is dead", which the auth circuit breaker (auth-circuit.ts)
// needs to distinguish from other non-retryable errors like a bad request body.
const authStatusCodes = new Set([401, 403]);
const permanentStatusCodes = new Set([400, 404, 409, 410, 413, 415, 422]);

export type PublishErrorClass = "transient" | "permanent" | "auth" | "unknown";

export class HttpPublishError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

/** Reads a provider-specified retry delay off any thrown HTTP error (HttpPublishError
 * or foundation/http.ts's ExternalHttpError both carry this field structurally). */
export function retryAfterSecondsFromError(error: unknown): number | null {
  if (typeof error !== "object" || error == null || !("retryAfterSeconds" in error)) return null;
  const value = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function classifyPublishError(error: unknown): PublishErrorClass {
  const status = typeof error === "object" && error != null && "status" in error && typeof error.status === "number" ? error.status : null;
  if (status != null) {
    if (transientStatusCodes.has(status)) return "transient";
    if (authStatusCodes.has(status)) return "auth";
    if (permanentStatusCodes.has(status)) return "permanent";
  }
  const text = String(error instanceof Error ? error.message : (error ?? "")).toLowerCase();
  // The worker stopped waiting for an external call. It is deliberately not
  // retried automatically: a late provider success must never create a
  // duplicate publication. An operator can reconcile and retry explicitly.
  if (text.includes("delivery_execution_timeout")) return "permanent";
  // The auth circuit breaker (auth-circuit.ts) short-circuits calls to a target
  // with a known-dead credential instead of hitting the provider again; treat
  // that as transient so the job keeps retrying on the normal backoff schedule
  // once the breaker clears, rather than burning its whole retry budget.
  if (text.includes("auth_circuit_open")) return "transient";
  if (
    ["timeout", "timed out", "temporarily", "connection reset", "network", "502", "503", "504", "429"].some((marker) =>
      text.includes(marker),
    )
  ) {
    return "transient";
  }
  if (["401", "403", "unauthorized", "forbidden", "invalid token"].some((marker) => text.includes(marker))) {
    return "auth";
  }
  if (["permission", "unsupported", "validation", "400"].some((marker) => text.includes(marker))) {
    return "permanent";
  }
  return "unknown";
}

export function nextRetryAt(
  attemptCount: number,
  baseSeconds: number,
  maxSeconds: number,
  now = new Date(),
  retryAfterSeconds: number | null = null,
): string {
  // A provider that returns Retry-After/X-RateLimit-Reset is telling us exactly
  // how long it wants silence; honor that instead of guessing with the
  // exponential curve, capped by the same ceiling as normal backoff.
  if (retryAfterSeconds != null) return new Date(now.getTime() + Math.min(retryAfterSeconds, maxSeconds) * 1000).toISOString();
  const delaySeconds = Math.min(maxSeconds, baseSeconds * 2 ** Math.max(0, attemptCount - 1));
  // Full jitter: spreads out retries that were all scheduled by the same
  // failure event so they don't all land on the provider in the same instant.
  const jitteredSeconds = delaySeconds * (0.5 + Math.random() * 0.5);
  return new Date(now.getTime() + jitteredSeconds * 1000).toISOString();
}

export type PublishResult = {
  ok?: boolean;
  skipped?: boolean;
  id?: string | number | null;
  ids?: unknown[] | null;
  url?: string | null;
  error?: string | null;
  reason?: string | null;
  retryable?: boolean;
  partial?: boolean;
  [key: string]: unknown;
};

export function normalizePublishResult(record: PublishResult | null | undefined) {
  const result = record && typeof record === "object" ? { ...record } : {};
  const ok = Boolean(result.ok);
  const skipped = Boolean(result.skipped);
  const status = ok ? "published" : skipped ? "skipped" : "failed";
  const ids = Array.isArray(result.ids) ? result.ids : null;
  let externalId = result.id == null ? null : String(result.id);
  const url = typeof result.url === "string" ? result.url : null;
  if (!externalId && ids && ids.length > 0) externalId = String(ids[0]);
  if (!externalId && url) externalId = url;
  const error = result.error ?? result.reason ?? null;
  if (!ok && !skipped && result.retryable == null) {
    result.retryable = classifyPublishError(error) === "transient";
  }
  return {
    status,
    externalId,
    externalIds: ids,
    url: url ?? (externalId?.startsWith("http") ? externalId : null),
    error: error == null ? null : String(error),
    skipped: skipped ? 1 : 0,
    rawJson: JSON.stringify(result),
  };
}
