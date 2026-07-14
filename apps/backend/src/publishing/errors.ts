const transientStatusCodes = new Set([408, 425, 429, 500, 502, 503, 504]);
const permanentStatusCodes = new Set([400, 401, 403, 404, 409, 410, 413, 415, 422]);

export type PublishErrorClass = "transient" | "permanent" | "unknown";

export class HttpPublishError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
  }
}

export function classifyPublishError(error: unknown): PublishErrorClass {
  const status = typeof error === "object" && error != null && "status" in error && typeof error.status === "number" ? error.status : null;
  if (status != null) {
    if (transientStatusCodes.has(status)) return "transient";
    if (permanentStatusCodes.has(status)) return "permanent";
  }
  const text = String(error instanceof Error ? error.message : (error ?? "")).toLowerCase();
  if (
    ["timeout", "timed out", "temporarily", "connection reset", "network", "502", "503", "504", "429"].some((marker) =>
      text.includes(marker),
    )
  ) {
    return "transient";
  }
  if (
    ["401", "403", "unauthorized", "forbidden", "invalid token", "permission", "unsupported", "validation", "400"].some((marker) =>
      text.includes(marker),
    )
  ) {
    return "permanent";
  }
  return "unknown";
}

export function nextRetryAt(attemptCount: number, baseSeconds: number, maxSeconds: number, now = new Date()): string {
  const delaySeconds = Math.min(maxSeconds, baseSeconds * 2 ** Math.max(0, attemptCount - 1));
  return new Date(now.getTime() + delaySeconds * 1000).toISOString();
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
