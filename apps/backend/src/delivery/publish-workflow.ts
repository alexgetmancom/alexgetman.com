import { and, eq } from "drizzle-orm";
import pLimit from "p-limit";
import type { BackendDb } from "../db/client.js";
import { postTargets, publishJobs } from "../db/schema.js";
import { recordDomainEvent } from "../domain/events.js";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";
import { recordWorkerState } from "../foundation/runtime/worker-state.js";
import { isTargetAuthBlocked } from "../observability/auth-circuit.js";
import { claimDuePublishJobs, completePublishJob, failPublishJob, recoverStalePublishJobs } from "../publishing/queue.js";
import { createPlatformPorts } from "./ports/social.js";
import { type DeliveryPort, type DeliveryPorts, deliveryAdapter } from "./ports.js";

/** Executes Publishing jobs through Delivery adapters without knowing any UI. */
export async function runDeliveryPublishCycle(
  config: BackendConfig,
  backendDb: BackendDb,
  publishers: DeliveryPorts | Record<string, DeliveryPort> = createPlatformPorts(config),
): Promise<number> {
  recoverStalePublishJobs(backendDb, config);
  const jobs = claimDuePublishJobs(backendDb, config.PUBLISH_CLAIM_LIMIT);
  // One lane per target instead of one shared pool: a single global pLimit let a
  // slow/hung target (e.g. Bluesky timing out) occupy every concurrency slot,
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
          completePublishJob(backendDb, config, job.jobId, { skipped: true, reason: `unsupported target: ${job.target}` }, job.lockId);
          return;
        }
        const adapter = "publish" in port ? port : deliveryAdapter(port);
        try {
          // A target with several consecutive 401/403s has a dead credential.
          // Skip the provider call entirely instead of repeating the same
          // rejected request, which is exactly the kind of traffic that gets
          // flagged as abuse.
          if (isTargetAuthBlocked(backendDb, job.target)) {
            throw new Error(`auth_circuit_open: ${job.target} has a failing credential, publish paused until it recovers`);
          }
          const result = await withHeartbeat(backendDb, job.jobId, config.PUBLISH_HEARTBEAT_INTERVAL_SECONDS, () =>
            withinPublishTimeout(config, job.target, async () => {
              await adapter.validate(job);
              const published = await adapter.publish(job);
              return adapter.verify(job, published);
            }),
          );
          completePublishJob(backendDb, config, job.jobId, result, job.lockId);
        } catch (error) {
          failPublishJob(backendDb, config, job.jobId, error, job.lockId);
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
    const now = new Date().toISOString();
    const finalized = backendDb.db
      .update(publishJobs)
      .set({ status: "failed", lockedBy: null, lockedAt: null, lastError: error, updatedAt: now })
      .where(and(eq(publishJobs.jobId, job.jobId), eq(publishJobs.status, "publishing"), eq(publishJobs.lockedBy, job.lockId)))
      .returning({ jobId: publishJobs.jobId })
      .get();
    if (!finalized) continue;
    backendDb.db
      .update(postTargets)
      .set({ status: "failed", error, skipped: 0, updatedAt: now })
      .where(and(eq(postTargets.postKey, job.postKey), eq(postTargets.target, job.target)))
      .run();
    try {
      recordDomainEvent(backendDb, {
        ref: job.postKey,
        target: job.target,
        type: "delivery.job.finalization_failed",
        severity: "error",
        message: error,
        details: { job_id: job.jobId },
        cooldownSeconds: 60 * 60,
      });
    } catch (eventError) {
      log("warn", "delivery event journal failed", { jobId: job.jobId, error: String(eventError) });
    }
  }
  const postIds = [...new Set(jobs.map((job) => job.postId).filter((id): id is number => id != null))];
  for (const postId of postIds) {
    try {
      recordDomainEvent(backendDb, {
        ref: `post:${postId}`,
        type: "delivery.post.settled",
        severity: "info",
        message: `Delivery cycle settled post #${postId}`,
        details: { post_id: postId },
        cooldownSeconds: 10,
      });
      const finalJobs = backendDb.db.select({ status: publishJobs.status }).from(publishJobs).where(eq(publishJobs.postId, postId)).all();
      if (finalJobs.length > 0 && finalJobs.every((job) => ["published", "failed", "cancelled", "skipped"].includes(job.status))) {
        const failed = finalJobs.filter((job) => job.status === "failed").length;
        recordDomainEvent(backendDb, {
          ref: `post:${postId}`,
          type: "delivery.post.completed",
          severity: failed ? "warn" : "info",
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

/** Keeps a claimed job's lock fresh while a slow provider call is in flight, so
 * recoverStalePublishJobs doesn't reclaim it mid-publish and risk a duplicate
 * post. Silence (a real crash) still goes stale after PUBLISH_LOCK_TIMEOUT_SECONDS
 * with no heartbeat. Mirrors video-worker.ts's withHeartbeat for videoJobs. */
async function withHeartbeat<T>(backendDb: BackendDb, jobId: number, intervalSeconds: number, work: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => {
    backendDb.db
      .update(publishJobs)
      .set({ lockedAt: new Date().toISOString() })
      .where(and(eq(publishJobs.jobId, jobId), eq(publishJobs.status, "publishing")))
      .run();
  }, intervalSeconds * 1000);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/**
 * A stuck provider promise must release the queue loop. The delayed provider
 * call is intentionally not retried automatically: it may still settle at the
 * provider after our deadline, so a human/Operations retry is the only safe
 * continuation.
 */
async function withinPublishTimeout<T>(config: BackendConfig, target: string, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `delivery_execution_timeout: ${target} exceeded ${config.PUBLISH_JOB_TIMEOUT_SECONDS}s; verify externally before retry`,
              ),
            ),
          config.PUBLISH_JOB_TIMEOUT_SECONDS * 1000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
