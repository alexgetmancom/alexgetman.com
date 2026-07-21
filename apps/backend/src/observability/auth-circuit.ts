import { eq } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { credentialChecks } from "../db/schema.js";
import { recordDomainEvent } from "../domain/events.js";

// A dead token retried on every publish attempt just re-triggers the same
// 401/403 against the provider, which is exactly the kind of repeated
// unauthorized traffic that gets an IP or app flagged. Trip the breaker after
// a few consecutive auth failures and stop calling the provider until either
// the cooldown elapses or a manual/automatic credential refresh succeeds.
const AUTH_FAILURE_THRESHOLD = 3;
const AUTH_BLOCK_COOLDOWN_SECONDS = 30 * 60;

type AuthCircuitDetails = {
  authFailureStreak?: number;
  blockedUntil?: string | null;
  lastAuthFailureAt?: string;
  lastPingAt?: string;
};

function parseDetails(json: string | null | undefined): AuthCircuitDetails {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Called after a publish attempt fails with errorClass "auth". */
export function recordAuthFailure(backendDb: BackendDb, target: string): void {
  const now = new Date();
  const row = backendDb.db.select().from(credentialChecks).where(eq(credentialChecks.target, target)).get();
  const details = parseDetails(row?.detailsJson);
  const streak = (details.authFailureStreak ?? 0) + 1;
  const tripped = streak >= AUTH_FAILURE_THRESHOLD;
  const blockedUntil = tripped
    ? new Date(now.getTime() + AUTH_BLOCK_COOLDOWN_SECONDS * 1000).toISOString()
    : (details.blockedUntil ?? null);
  const nextDetails: AuthCircuitDetails = { authFailureStreak: streak, blockedUntil, lastAuthFailureAt: now.toISOString() };
  if (row) {
    backendDb.db
      .update(credentialChecks)
      .set({ detailsJson: JSON.stringify(nextDetails) })
      .where(eq(credentialChecks.target, target))
      .run();
  } else {
    backendDb.db
      .insert(credentialChecks)
      .values({
        target,
        status: "unknown",
        requiredEnvJson: "[]",
        missingEnvJson: "[]",
        lastCheckedAt: now.toISOString(),
        detailsJson: JSON.stringify(nextDetails),
      })
      .run();
  }
  if (tripped && streak === AUTH_FAILURE_THRESHOLD) {
    recordDomainEvent(backendDb, {
      target,
      type: "credential.auth_circuit_tripped",
      severity: "error",
      message: `${target}: ${streak} consecutive auth failures, pausing publishes for ${AUTH_BLOCK_COOLDOWN_SECONDS / 60}m`,
      details: { target, streak, blockedUntil },
      cooldownSeconds: AUTH_BLOCK_COOLDOWN_SECONDS,
    });
  }
}

/** Called after a publish attempt to `target` succeeds, to clear any tripped breaker. */
export function recordAuthSuccess(backendDb: BackendDb, target: string): void {
  const row = backendDb.db.select().from(credentialChecks).where(eq(credentialChecks.target, target)).get();
  if (!row) return;
  const details = parseDetails(row.detailsJson);
  if (!details.authFailureStreak && !details.blockedUntil) return;
  // Preserve unrelated fields (e.g. token-health.ts's lastPingAt) instead of
  // wiping the whole details blob, but still clear every circuit-breaker field.
  const nextDetails: AuthCircuitDetails = { ...details, authFailureStreak: 0, blockedUntil: null };
  delete nextDetails.lastAuthFailureAt;
  backendDb.db
    .update(credentialChecks)
    .set({ detailsJson: JSON.stringify(nextDetails) })
    .where(eq(credentialChecks.target, target))
    .run();
}

/** Checked before a publish call is attempted for `target`. */
export function isTargetAuthBlocked(backendDb: BackendDb, target: string): boolean {
  const row = backendDb.db.select().from(credentialChecks).where(eq(credentialChecks.target, target)).get();
  if (!row) return false;
  const details = parseDetails(row.detailsJson);
  return Boolean(details.blockedUntil && details.blockedUntil > new Date().toISOString());
}

/** Throttles token-health.ts's live pings independently of the 5-minute
 * observability cadence, so we don't hit every provider's "whoami" endpoint
 * every cycle. */
export function shouldPingToken(backendDb: BackendDb, target: string, intervalSeconds: number): boolean {
  const row = backendDb.db.select().from(credentialChecks).where(eq(credentialChecks.target, target)).get();
  const details = parseDetails(row?.detailsJson);
  if (!details.lastPingAt) return true;
  return Date.now() - new Date(details.lastPingAt).getTime() >= intervalSeconds * 1000;
}

/** Records that a live token probe ran, and its discovered expiry if the
 * provider reported one (see credentialChecks.expiresAt). */
export function recordTokenPing(backendDb: BackendDb, target: string, tokenExpiresAt?: string | null): void {
  const now = new Date().toISOString();
  const row = backendDb.db.select().from(credentialChecks).where(eq(credentialChecks.target, target)).get();
  const details = parseDetails(row?.detailsJson);
  const nextDetails: AuthCircuitDetails = { ...details, lastPingAt: now };
  if (row) {
    backendDb.db
      .update(credentialChecks)
      .set({ detailsJson: JSON.stringify(nextDetails), ...(tokenExpiresAt !== undefined ? { expiresAt: tokenExpiresAt } : {}) })
      .where(eq(credentialChecks.target, target))
      .run();
  } else {
    backendDb.db
      .insert(credentialChecks)
      .values({
        target,
        status: "unknown",
        requiredEnvJson: "[]",
        missingEnvJson: "[]",
        lastCheckedAt: now,
        detailsJson: JSON.stringify(nextDetails),
        expiresAt: tokenExpiresAt ?? null,
      })
      .run();
  }
}
