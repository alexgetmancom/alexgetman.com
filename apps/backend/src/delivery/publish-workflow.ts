import { and, eq } from "drizzle-orm";
import pLimit from "p-limit";
import type { BackendDb } from "../db/client.js";
import { postTargets, publishJobs } from "../db/schema.js";
import { recordDomainEvent } from "../domain/events.js";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";
import { recordWorkerState } from "../foundation/runtime/worker-state.js";
import { claimDuePublishJobs, completePublishJob, failPublishJob, recoverStalePublishJobs } from "../publishing/queue.js";
import { createPlatformPorts } from "./ports/social.js";
import type { DeliveryPort } from "./ports.js";

/** Executes Publishing jobs through Delivery adapters without knowing any UI. */
export async function runDeliveryPublishCycle(
  config: BackendConfig,
  backendDb: BackendDb,
  publishers: Record<string, DeliveryPort> = createPlatformPorts(config, backendDb),
): Promise<number> {
  recoverStalePublishJobs(backendDb, config.PUBLISH_LOCK_TIMEOUT_SECONDS);
  const jobs = claimDuePublishJobs(backendDb, config.PUBLISH_CLAIM_LIMIT);
  const publishLimit = pLimit(config.PUBLISH_MAX_CONCURRENCY);
  const results = await Promise.allSettled(
    jobs.map((job) =>
      publishLimit(async () => {
        const publisher = publishers[job.target];
        if (!publisher) {
          completePublishJob(backendDb, config, job.jobId, { skipped: true, reason: `unsupported target: ${job.target}` }, job.lockId);
          return;
        }
        try {
          completePublishJob(backendDb, config, job.jobId, await publisher(job), job.lockId);
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
    backendDb.db
      .update(publishJobs)
      .set({ status: "failed", lockedBy: null, lockedAt: null, lastError: error, updatedAt: now })
      .where(and(eq(publishJobs.jobId, job.jobId), eq(publishJobs.status, "publishing")))
      .run();
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
  for (const postId of postIds)
    recordDomainEvent(backendDb, {
      ref: `post:${postId}`,
      type: "delivery.post.settled",
      severity: "info",
      message: `Delivery cycle settled post #${postId}`,
      details: { post_id: postId },
      cooldownSeconds: 10,
    });
  recordWorkerState(backendDb, "queue", { claimed: jobs.length });
  return jobs.length;
}
