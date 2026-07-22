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
