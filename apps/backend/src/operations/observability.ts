import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import type { Bot } from "grammy";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { alertDedup, credentialChecks, postEvents, publishJobs, siteJobs } from "../db/schema.js";
import { recordWorkerState } from "../runtime/worker-state.js";
import { notificationService } from "../studio/services/notifications.js";

const REQUIREMENTS: Record<string, string[]> = {
  controller_bot: ["CONTROLLER_BOT_TOKEN", "ADMIN_IDS"],
  telegram: ["CONTROLLER_BOT_TOKEN"],
  threads_ru: ["THREADS_ACCESS_TOKEN"],
  threads_en: ["THREADS_EN_ACCESS_TOKEN"],
  facebook: ["FACEBOOK_PAGE_ID", "FACEBOOK_PAGE_ACCESS_TOKEN"],
  facebook_ru: ["FACEBOOK_RU_PAGE_ID", "FACEBOOK_RU_PAGE_ACCESS_TOKEN"],
  linkedin: ["LINKEDIN_AUTHOR_URN", "LINKEDIN_ACCESS_TOKEN"],
  x: ["X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"],
  bluesky: ["BLUESKY_HANDLE", "BLUESKY_APP_PASSWORD"],
  mastodon: ["MASTODON_INSTANCE", "MASTODON_ACCESS_TOKEN"],
  devto: ["DEVTO_API_KEY"],
  github: ["GITHUB_DISCUSSIONS_TOKEN"],
  telegram_stories: ["TELEGRAM_CHANNEL_STORIES_API_ID", "TELEGRAM_CHANNEL_STORIES_API_HASH", "TELEGRAM_CHANNEL_STORIES_SESSION"],
  instagram_stories: ["INSTAGRAM_EN_USER_ID", "INSTAGRAM_EN_ACCESS_TOKEN"],
  instagram_stories_ru: ["INSTAGRAM_RU_USER_ID", "INSTAGRAM_RU_ACCESS_TOKEN"],
};

export async function runObservabilityCycle(
  config: BackendConfig,
  backendDb: BackendDb,
  bot: Bot | null,
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
    if (bot && config.ADMIN_IDS[0]) {
      await bot.api.sendMessage(
        config.ADMIN_IDS[0],
        `[${event.severity.toUpperCase()}] ${event.target ?? event.eventType}\n${event.message}`.slice(0, 4000),
      );
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
    notificationService(backendDb).record({
      ref: job.postKey,
      type: "queue.stale",
      severity: "error",
      target: job.target,
      message: `Publish job ${job.jobId} exceeded lock timeout`,
      details: { jobId: job.jobId, lockedAt: job.lockedAt },
      cooldownSeconds: config.ALERT_COOLDOWN_SECONDS,
    });
  for (const job of failed)
    notificationService(backendDb).record({
      ref: job.postKey,
      type: "target.failed",
      severity: "error",
      target: job.target,
      message: job.lastError ?? `${job.target} failed`,
      cooldownSeconds: config.ALERT_COOLDOWN_SECONDS,
    });
  for (const job of failedSite)
    notificationService(backendDb).record({
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
  const values = config as unknown as Record<string, unknown>;
  const now = new Date().toISOString();
  for (const [target, required] of Object.entries(REQUIREMENTS)) {
    const missing = required.filter((name) => (name === "ADMIN_IDS" ? config.ADMIN_IDS.length === 0 : !values[name]));
    const status = missing.length ? "missing" : "ready";
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
  return Object.keys(REQUIREMENTS).length;
}
