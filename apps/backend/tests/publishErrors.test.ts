import { describe, expect, it } from "bun:test";
import { retryAfterSecondsFromHeaders } from "../src/foundation/http.js";
import { classifyPublishError, HttpPublishError, nextRetryAt, retryAfterSecondsFromError } from "../src/publishing/errors.js";

describe("classifyPublishError", () => {
  it("splits 401/403 into their own auth class, separate from other permanent errors", () => {
    expect(classifyPublishError(new HttpPublishError("nope", 401))).toBe("auth");
    expect(classifyPublishError(new HttpPublishError("nope", 403))).toBe("auth");
    expect(classifyPublishError(new HttpPublishError("bad request", 400))).toBe("permanent");
    expect(classifyPublishError(new Error("Unauthorized"))).toBe("auth");
  });

  it("treats a tripped auth circuit breaker as transient so retries resume once it clears", () => {
    expect(classifyPublishError(new Error("auth_circuit_open: mastodon has a failing credential"))).toBe("transient");
  });
});

describe("retryAfterSecondsFromHeaders", () => {
  it("parses a numeric Retry-After header", () => {
    expect(retryAfterSecondsFromHeaders(new Headers({ "retry-after": "120" }))).toBe(120);
  });

  it("parses an X-RateLimit-Reset unix timestamp relative to now", () => {
    const resetEpochSeconds = Math.floor(Date.now() / 1000) + 60;
    const seconds = retryAfterSecondsFromHeaders(new Headers({ "x-ratelimit-reset": String(resetEpochSeconds) }));
    expect(seconds).toBeGreaterThanOrEqual(55);
    expect(seconds).toBeLessThanOrEqual(60);
  });

  it("returns null when no rate-limit headers are present", () => {
    expect(retryAfterSecondsFromHeaders(new Headers())).toBeNull();
  });
});

describe("nextRetryAt", () => {
  it("honors an explicit retry-after delay instead of the exponential curve", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const result = nextRetryAt(1, 60, 3600, now, 45);
    expect(result).toBe("2026-01-01T00:00:45.000Z");
  });

  it("caps a provider-requested delay at the configured backoff ceiling", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const result = nextRetryAt(1, 60, 300, now, 10_000);
    expect(result).toBe("2026-01-01T00:05:00.000Z");
  });
});

describe("retryAfterSecondsFromError", () => {
  it("reads retryAfterSeconds off an HttpPublishError", () => {
    expect(retryAfterSecondsFromError(new HttpPublishError("rate limited", 429, undefined, 30))).toBe(30);
  });

  it("returns null when the error has no retryAfterSeconds", () => {
    expect(retryAfterSecondsFromError(new Error("boom"))).toBeNull();
  });
});
