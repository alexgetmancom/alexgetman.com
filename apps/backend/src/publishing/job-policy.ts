import type { JsonObject } from "../db/schema.js";
import { classifyPublishError, nextRetryAt, type PublishErrorClass, retryAfterSecondsFromError } from "./errors.js";

type RetryPolicy = { maxAttempts: number; backoffBaseSeconds: number; backoffMaxSeconds: number };
type FailedJobTransition = {
  attempt: number;
  errorClass: PublishErrorClass;
  status: "queued" | "failed";
  nextAttemptAt: string | null;
};

/** Pure retry policy: transient errors use the configured budget (four total
 * attempts by default: initial delivery plus three retries); unknown errors
 * get one safe retry and permanent/auth errors never risk a duplicate post. */
export function failedJobTransition(error: unknown, currentAttempt: number, policy: RetryPolicy): FailedJobTransition {
  const attempt = currentAttempt + 1;
  const errorClass = classifyPublishError(error);
  const retry = (errorClass === "transient" && attempt < policy.maxAttempts) || (errorClass === "unknown" && attempt < 2);
  return {
    attempt,
    errorClass,
    status: retry ? "queued" : "failed",
    nextAttemptAt: retry
      ? nextRetryAt(attempt, policy.backoffBaseSeconds, policy.backoffMaxSeconds, undefined, retryAfterSecondsFromError(error))
      : null,
  };
}

export function reconciliationTransition(
  currentAttempt: number,
  policy: RetryPolicy,
): Pick<FailedJobTransition, "attempt" | "status" | "nextAttemptAt"> {
  const attempt = currentAttempt + 1;
  const retry = attempt < policy.maxAttempts;
  return {
    attempt,
    status: retry ? "queued" : "failed",
    nextAttemptAt: retry ? nextRetryAt(attempt, policy.backoffBaseSeconds, policy.backoffMaxSeconds) : null,
  };
}

/** The columns a publish job takes on when it re-enters the queue. Two paths
 * requeue jobs and they mean different things -- Studio retries a target that
 * failed, `ops retry` restores one whatever state it reached -- so *which*
 * jobs each may touch stays a guard at the call site. What must not differ is
 * the row they leave behind: a job waiting to be claimed has shed its lock, its
 * backoff and the phase of its previous attempt.
 *
 * `currentPhase` is the one that bites. recoverStalePublishJobs reads it to
 * decide whether a lost worker may already have hit the provider, and the ops
 * path used to leave it set, so a later stale lock on a clean retry was
 * misreported as needing manual verification. */
export function requeuedPublishJobColumns(payload: JsonObject, now: string) {
  return {
    status: "queued" as const,
    attemptCount: 0,
    publishAt: now,
    nextAttemptAt: null,
    lockedBy: null,
    lockedAt: null,
    currentPhase: null,
    payloadJson: payload,
    lastError: null,
    updatedAt: now,
  };
}

/** The post_targets row that mirrors a requeued job. post_targets is what the
 * Command Center and the bot read, so the three places that requeue -- ops for
 * social, ops for the site, Studio's retry -- have to agree on it exactly; they
 * each spelled it out instead, which is how the publish-job column set drifted. */
export function requeuedPostTarget(postKey: string, target: string, now: string) {
  const patch = {
    status: "queued" as const,
    error: null,
    skipped: 0,
    // The identity of the remote object this row used to name. A requeued row
    // is about to describe a different one, and leaving the old id, url and
    // timestamps behind is how `verify` reported a deleted post as live and
    // `delete` aimed at something that was no longer there.
    externalId: null,
    externalIdsJson: null,
    url: null,
    publishedAt: null,
    confirmationSource: null,
    verifiedAt: null,
    updatedAt: now,
    rawJson: JSON.stringify({ requeued: true }),
  };
  return { values: { postKey, target, ...patch }, patch };
}
