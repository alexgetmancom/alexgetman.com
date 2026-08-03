import { and, eq } from "drizzle-orm";
import pLimit from "p-limit";
import type { BackendDb } from "../db/client.js";
import { publishJobs } from "../db/schema.js";
import { recordDomainEvent } from "../domain/events.js";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";
import { withJobHeartbeat } from "../foundation/runtime/job-heartbeat.js";
import { recordWorkerState } from "../foundation/runtime/worker-state.js";
import { isTargetAuthBlocked } from "../observability/auth-circuit.js";
import { trackUsageAsync } from "../observability/usage.js";
import {
  claimDuePublishJobs,
  completePublishJob,
  failPublishJob,
  forcePublishJobVerification,
  recoverStalePublishJobs,
  requirePublishVerification,
} from "../publishing/queue.js";
import { AmbiguousPublicationError, isAmbiguousPublicationError } from "./ambiguous-publication.js";
import { createPlatformPorts } from "./ports/social.js";
import type { DeliveryPorts, DeliveryPublisher } from "./ports.js";

/** Executes Publishing jobs through Delivery adapters without knowing any UI. */
export async function runDeliveryPublishCycle(
  config: BackendConfig,
  backendDb: BackendDb,
  publishers: DeliveryPorts = createPlatformPorts(config),
): Promise<number> {
  recoverStalePublishJobs(backendDb, config);
  const jobs = claimDuePublishJobs(backendDb, config.PUBLISH_CLAIM_LIMIT);
  // One lane per target instead of one shared pool: a single global pLimit let a
  // slow/hung target occupy every concurrency slot,
  // so unrelated targets (Telegram, Threads, ...) sat waiting behind it even
  // though they had nothing to do with the stuck call. Each target still runs
  // its own jobs one at a time (platforms are sensitive to bursts anyway), but
  // different targets never block each other.
  const targetLimits = new Map<string, ReturnType<typeof pLimit>>();
  const limitForTarget = (target: string) => {
    let limit = targetLimits.get(target);
    if (!limit) {
      limit = pLimit(1);
      targetLimits.set(target, limit);
    }
    return limit;
  };
  const results = await Promise.allSettled(
    jobs.map((job) =>
      limitForTarget(job.target)(async () => {
        const port = publishers[job.target];
        if (!port) {
          try {
            failPublishJob(backendDb, config, job.jobId, new Error(`unsupported delivery target: ${job.target}`), job.lockId);
          } catch (error) {
            settleUnexpectedFinalization(backendDb, job, error);
          }
          return;
        }
        const adapter = port;
        let result: Awaited<ReturnType<DeliveryPublisher>>;
        try {
          result = await trackUsageAsync(backendDb, "publishing.social.job", async () => {
            // A target with several consecutive 401/403s has a dead credential.
            // Skip the provider call entirely instead of repeating the same
            // rejected request, which is exactly the kind of traffic that gets
            // flagged as abuse.
            if (isTargetAuthBlocked(backendDb, job.target)) {
              throw new Error(`auth_circuit_open: ${job.target} has a failing credential, publish paused until it recovers`);
            }
            const result = await withJobHeartbeat(
              config.PUBLISH_HEARTBEAT_INTERVAL_SECONDS,
              () =>
                backendDb.db
                  .update(publishJobs)
                  .set({ lockedAt: new Date().toISOString() })
                  .where(and(eq(publishJobs.jobId, job.jobId), eq(publishJobs.status, "publishing"), eq(publishJobs.lockedBy, job.lockId)))
                  .run(),
              () =>
                withinPublishTimeout(config, backendDb, job, async () => {
                  await timedDeliveryPhase(backendDb, job, "validate", () => adapter.validate(job));
                  const prepared = await timedDeliveryPhase(backendDb, job, "prepare", () => adapter.prepare(job));
                  const published = await timedDeliveryPhase(backendDb, job, "provider.publish", () => adapter.publish(prepared));
                  return timedDeliveryPhase(backendDb, job, "provider.verify", () => adapter.verify(job, published), published);
                }),
            );
            return result;
          });
        } catch (error) {
          if (isAmbiguousPublicationError(error)) requirePublishVerification(backendDb, job.jobId, error, job.lockId);
          else failPublishJob(backendDb, config, job.jobId, error, job.lockId);
          return;
        }
        try {
          completePublishJob(backendDb, config, job.jobId, result, job.lockId);
        } catch (error) {
          settleUnexpectedFinalization(backendDb, job, error, result);
        }
      }),
    ),
  );
  for (const [index, result] of results.entries()) {
    if (result.status !== "rejected") continue;
    const job = jobs[index];
    if (!job) continue;
    const error = `worker finalization failed: ${String(result.reason instanceof Error ? result.reason.message : result.reason)}`;
    log("error", "publish job finalization failed", { jobId: job.jobId, target: job.target, error });
    try {
      forcePublishJobVerification(backendDb, job.jobId, error, job.lockId);
    } catch (finalizationError) {
      log("error", "publish job emergency settlement failed", { jobId: job.jobId, target: job.target, error: String(finalizationError) });
    }
  }
  const postIds = [...new Set(jobs.map((job) => job.postId).filter((id): id is number => id != null))];
  for (const postId of postIds) {
    try {
      recordDomainEvent(backendDb.events, {
        ref: `post:${postId}`,
        type: "delivery.post.settled",
        severity: "info",
        message: `Delivery cycle settled post #${postId}`,
        details: { post_id: postId },
        cooldownSeconds: 10,
      });
      const finalJobs = backendDb.db.select({ status: publishJobs.status }).from(publishJobs).where(eq(publishJobs.postId, postId)).all();
      if (
        finalJobs.length > 0 &&
        finalJobs.every((job) => ["published", "failed", "cancelled", "skipped", "verification_required"].includes(job.status))
      ) {
        const failed = finalJobs.filter((job) => job.status === "failed" || job.status === "verification_required").length;
        recordDomainEvent(backendDb.events, {
          ref: `post:${postId}`,
          type: "delivery.post.completed",
          // The terminal target already emitted the single actionable
          // `publish.job.failed` error alert. Keep this aggregate completion
          // informational so a partially failed post does not notify twice.
          severity: "info",
          message: failed ? `Post #${postId} completed with ${failed} failed target(s)` : `Post #${postId} published successfully`,
          details: {
            post_id: postId,
            total: finalJobs.length,
            failed,
            published: finalJobs.filter((job) => job.status === "published").length,
          },
          cooldownSeconds: 60 * 60,
        });
      }
    } catch (eventError) {
      // A domain-event write failure here must not stop the loop from settling
      // the remaining posts in this cycle; see the finalization-failure event
      // above, which is defensive for the same reason.
      log("warn", "delivery post-settlement event journal failed", { postId, error: String(eventError) });
    }
  }
  recordWorkerState(backendDb, "queue", { claimed: jobs.length });
  return jobs.length;
}

function settleUnexpectedFinalization(
  backendDb: BackendDb,
  job: { jobId: number; target: string; lockId: string },
  error: unknown,
  result: Awaited<ReturnType<DeliveryPublisher>> | null = null,
): void {
  const message = `worker finalization failed: ${String(error instanceof Error ? error.message : error)}`;
  log("error", "publish job finalization failed", { jobId: job.jobId, target: job.target, error: message });
  try {
    forcePublishJobVerification(backendDb, job.jobId, message, job.lockId, result);
  } catch (finalizationError) {
    log("error", "publish job emergency settlement failed", {
      jobId: job.jobId,
      target: job.target,
      error: String(finalizationError),
    });
  }
}

async function timedDeliveryPhase<T>(
  backendDb: BackendDb,
  job: { jobId: number; postKey: string; target: string; attemptCount: number; lockId: string },
  phase: string,
  work: () => Promise<T>,
  providerResult?: unknown,
): Promise<T> {
  const startedAt = Date.now();
  const owned = backendDb.db
    .select({ jobId: publishJobs.jobId })
    .from(publishJobs)
    .where(and(eq(publishJobs.jobId, job.jobId), eq(publishJobs.status, "publishing"), eq(publishJobs.lockedBy, job.lockId)))
    .get();
  if (!owned) throw new Error(`delivery_job_no_longer_owned:${job.jobId}`);
  backendDb.db
    .update(publishJobs)
    .set({ currentPhase: phase, updatedAt: new Date().toISOString() })
    .where(and(eq(publishJobs.jobId, job.jobId), eq(publishJobs.status, "publishing")))
    .run();
  try {
    const result = await work();
    const durationMs = Date.now() - startedAt;
    try {
      recordDomainEvent(backendDb.events, {
        ref: job.postKey,
        target: job.target,
        type: "publish.job.phase",
        severity: "info",
        message: `${job.target} ${phase} completed`,
        details: {
          job_id: job.jobId,
          attempt: job.attemptCount,
          phase,
          status: "completed",
          duration_ms: durationMs,
          provider_request_id: providerRequestId(result) ?? providerRequestId(providerResult),
        },
      });
    } catch (eventError) {
      log("warn", "publish phase event journal failed", { jobId: job.jobId, target: job.target, phase, error: String(eventError) });
    }
    return result;
  } catch (error) {
    try {
      recordDomainEvent(backendDb.events, {
        ref: job.postKey,
        target: job.target,
        type: "publish.job.phase",
        severity: "error",
        message: `${job.target} ${phase} failed`,
        details: {
          job_id: job.jobId,
          attempt: job.attemptCount,
          phase,
          status: "failed",
          duration_ms: Date.now() - startedAt,
          provider_request_id: providerRequestId(providerResult),
          error: String(error instanceof Error ? error.message : error),
        },
      });
    } catch (eventError) {
      log("warn", "publish phase event journal failed", { jobId: job.jobId, target: job.target, phase, error: String(eventError) });
    }
    throw error;
  }
}

function providerRequestId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  for (const key of ["providerRequestId", "requestId", "request_id", "xRequestId"]) {
    const candidate = row[key];
    if (typeof candidate === "string" && candidate) return candidate;
  }
  const raw = row.raw;
  return raw && typeof raw === "object" ? providerRequestId(raw) : null;
}

/**
 * A stuck provider promise must release the queue loop. The delayed provider
 * call releases the worker. Ambiguity is assigned only by the provider adapter
 * around its public mutation; preparation and verification timeouts remain
 * ordinary retryable failures.
 */
async function withinPublishTimeout<T>(
  config: BackendConfig,
  backendDb: BackendDb,
  job: { jobId: number; target: string },
  work: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const phase = backendDb.db
            .select({ currentPhase: publishJobs.currentPhase })
            .from(publishJobs)
            .where(eq(publishJobs.jobId, job.jobId))
            .get()?.currentPhase;
          const timeout = new Error(
            `delivery_execution_timeout: ${job.target} exceeded ${config.PUBLISH_JOB_TIMEOUT_SECONDS}s during ${phase ?? "unknown"}`,
          );
          reject(phase === "provider.publish" ? new AmbiguousPublicationError(job.target, timeout) : timeout);
        }, config.PUBLISH_JOB_TIMEOUT_SECONDS * 1000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
