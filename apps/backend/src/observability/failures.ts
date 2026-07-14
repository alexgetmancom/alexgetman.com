import { and, desc, eq, lt } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { publishJobs, siteJobs } from "../db/schema.js";
import { recordDomainEvent } from "../domain/events.js";
import type { BackendConfig } from "../foundation/config.js";

/** Records Delivery failures as durable domain events; no alert transport is used here. */
export function recordPublicationFailures(config: BackendConfig, backendDb: BackendDb): void {
  const staleBefore = new Date(Date.now() - config.PUBLISH_LOCK_TIMEOUT_SECONDS * 1000).toISOString();
  const stale = backendDb.db
    .select()
    .from(publishJobs)
    .where(and(eq(publishJobs.status, "publishing"), lt(publishJobs.lockedAt, staleBefore)))
    .all();
  const failed = backendDb.db
    .select()
    .from(publishJobs)
    .where(eq(publishJobs.status, "failed"))
    .orderBy(desc(publishJobs.updatedAt))
    .limit(100)
    .all();
  const failedSite = backendDb.db
    .select()
    .from(siteJobs)
    .where(eq(siteJobs.status, "failed"))
    .orderBy(desc(siteJobs.updatedAt))
    .limit(100)
    .all();
  for (const job of stale)
    recordDomainEvent(backendDb, {
      ref: job.postKey,
      type: "queue.stale",
      severity: "error",
      target: job.target,
      message: `Publish job ${job.jobId} exceeded lock timeout`,
      details: { jobId: job.jobId, lockedAt: job.lockedAt },
      cooldownSeconds: config.ALERT_COOLDOWN_SECONDS,
    });
  for (const job of failed)
    recordDomainEvent(backendDb, {
      ref: job.postKey,
      type: "target.failed",
      severity: "error",
      target: job.target,
      message: job.lastError ?? `${job.target} failed`,
      cooldownSeconds: config.ALERT_COOLDOWN_SECONDS,
    });
  for (const job of failedSite)
    recordDomainEvent(backendDb, {
      ref: job.postId == null ? null : `post:${job.postId}`,
      type: "site.build.failed",
      severity: "error",
      target: "site",
      message: job.lastError ?? `Site job ${job.jobId} failed`,
      details: { jobId: job.jobId, reason: job.reason },
      cooldownSeconds: config.ALERT_COOLDOWN_SECONDS,
    });
}
