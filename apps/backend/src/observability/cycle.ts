import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { alertDedup, credentialChecks, postEvents, publishJobs, siteJobs } from "../db/schema.js";
import { recordDomainEvent } from "../domain/events.js";
import type { BackendConfig } from "../foundation/config.js";
import { recordWorkerState } from "../foundation/runtime/worker-state.js";
import { capabilityReport } from "./capabilities.js";

type OperationsAlertPort = { sendAlert?: (text: string) => Promise<void> };

/** Operations emits alerts through a port; Telegram is only one possible adapter. */
export async function runObservabilityCycle(
  config: BackendConfig,
  backendDb: BackendDb,
  alertsPort: OperationsAlertPort = {},
): Promise<{ alerts: number; credentials: number }> {
  const credentials = updateCredentialChecks(config, backendDb);
  scanPublicationFailures(config, backendDb);
  let alerts = 0;
  const events = backendDb.db
    .select({
      id: postEvents.id,
      eventType: postEvents.eventType,
      severity: postEvents.severity,
      target: postEvents.target,
      message: postEvents.message,
      createdAt: postEvents.createdAt,
    })
    .from(postEvents)
    .where(and(inArray(postEvents.severity, ["warn", "error"]), isNull(postEvents.ackedAt)))
    .orderBy(asc(postEvents.createdAt), asc(postEvents.id))
    .limit(20)
    .all();
  for (const event of events) {
    const key = crypto
      .createHash("sha256")
      .update(`${event.eventType}\0${event.target ?? ""}\0${event.message}`)
      .digest("hex");
    const dedup = backendDb.db.select().from(alertDedup).where(eq(alertDedup.alertKey, key)).get();
    const cooling = dedup?.lastSentAt && Date.now() - new Date(dedup.lastSentAt).getTime() < config.ALERT_COOLDOWN_SECONDS * 1000;
    if (cooling) {
      backendDb.db
        .update(alertDedup)
        .set({ suppressedCount: (dedup.suppressedCount ?? 0) + 1 })
        .where(eq(alertDedup.alertKey, key))
        .run();
      backendDb.db.update(postEvents).set({ ackedAt: new Date().toISOString() }).where(eq(postEvents.id, event.id)).run();
      continue;
    }
    if (alertsPort.sendAlert) {
      await alertsPort.sendAlert(`[${event.severity.toUpperCase()}] ${event.target ?? event.eventType}\n${event.message}`.slice(0, 4000));
      alerts += 1;
      const now = new Date().toISOString();
      backendDb.db
        .insert(alertDedup)
        .values({ alertKey: key, lastSentAt: now, suppressedCount: 0 })
        .onConflictDoUpdate({ target: alertDedup.alertKey, set: { lastSentAt: now, suppressedCount: 0 } })
        .run();
      backendDb.db.update(postEvents).set({ ackedAt: now }).where(eq(postEvents.id, event.id)).run();
    }
  }
  recordWorkerState(backendDb, "observability", { alerts, credentials });
  return { alerts, credentials };
}

function scanPublicationFailures(config: BackendConfig, backendDb: BackendDb): void {
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

function updateCredentialChecks(config: BackendConfig, backendDb: BackendDb): number {
  const now = new Date().toISOString();
  const report = capabilityReport(config);
  for (const { target, required, missing, status } of report) {
    const nextCheckAt = new Date(Date.now() + 3_600_000).toISOString();
    backendDb.db
      .insert(credentialChecks)
      .values({
        target,
        status,
        requiredEnvJson: JSON.stringify(required),
        missingEnvJson: JSON.stringify(missing),
        lastCheckedAt: now,
        nextCheckAt,
        detailsJson: "{}",
      })
      .onConflictDoUpdate({
        target: credentialChecks.target,
        set: {
          status,
          requiredEnvJson: JSON.stringify(required),
          missingEnvJson: JSON.stringify(missing),
          lastCheckedAt: now,
          nextCheckAt,
          lastError: null,
        },
      })
      .run();
  }
  return report.length;
}
