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
import { type DeliveryPort, type DeliveryPorts, deliveryAdapter } from "./ports.js";

/** Executes Publishing jobs through Delivery adapters without knowing any UI. */
export async function runDeliveryPublishCycle(
  config: BackendConfig,
  backendDb: BackendDb,
  publishers: DeliveryPorts | Record<string, DeliveryPort> = createPlatformPorts(config, backendDb),
): Promise<number> {
  recoverStalePublishJobs(backendDb, config.PUBLISH_LOCK_TIMEOUT_SECONDS);
  const jobs = claimDuePublishJobs(backendDb, config.PUBLISH_CLAIM_LIMIT);
  const publishLimit = pLimit(config.PUBLISH_MAX_CONCURRENCY);
  const results = await Promise.allSettled(
    jobs.map((job) =>
      publishLimit(async () => {
        const port = publishers[job.target];
        if (!port) {
          completePublishJob(backendDb, config, job.jobId, { skipped: true, reason: `unsupported target: ${job.target}` }, job.lockId);
          return;
        }
        const adapter = "publish" in port ? port : deliveryAdapter(port);
        try {
          await adapter.validate(job);
          const published = await adapter.publish(job);
          completePublishJob(backendDb, config, job.jobId, await adapter.verify(job, published), job.lockId);
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
