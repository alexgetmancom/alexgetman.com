import { and, eq } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { postTargets, publishJobs, videoDrafts, videoJobs, videoTargets } from "../db/schema.js";
import { recordDomainEvent } from "../domain/events.js";
import type { BackendConfig } from "../foundation/config.js";
import { reconcilePublication } from "../publishing/queue.js";
import { refreshVideoDraftStatus } from "../publishing/video-data.js";
import { platformConfig, verifyPlatformPublication } from "./ports/social.js";
import { verifyYouTubeVideo } from "./video-publishers.js";
import { verifyZernioPost } from "./zernio.js";

type ReconciliationResult = { checked: number; resolved: number; unresolved: number; oldestAt: string | null };

/** Resolves only cases backed by a durable provider ID. A missing ID remains
 * visible for an operator; guessing by title or timestamp is not safe enough
 * for a reusable self-hosted default. */
export async function runPublicationReconciliation(backendDb: BackendDb, config: BackendConfig): Promise<ReconciliationResult> {
  let checked = 0;
  let resolved = 0;
  const ordinary = backendDb.db
    .select({ job: publishJobs, target: postTargets })
    .from(publishJobs)
    .innerJoin(postTargets, and(eq(postTargets.postKey, publishJobs.postKey), eq(postTargets.target, publishJobs.target)))
    .where(eq(publishJobs.status, "verification_required"))
    .all();
  for (const row of ordinary) {
    checked += 1;
    const externalId = row.target.externalId;
    if (!externalId) continue;
    const result = await verifyPlatformPublication(
      row.job.target,
      { ok: true, id: externalId, url: row.target.url },
      platformConfig(row.job.target, config),
    );
    const verification = result.verification as { status?: string } | undefined;
    if (verification?.status === "unavailable") continue;
    const now = new Date().toISOString();
    backendDb.db.transaction((tx) => {
      tx.update(publishJobs)
        .set({ status: "published", currentPhase: null, lastError: null, updatedAt: now })
        .where(and(eq(publishJobs.jobId, row.job.jobId), eq(publishJobs.status, "verification_required")))
        .run();
      tx.update(postTargets)
        .set({
          status: "published",
          error: null,
          url: typeof result.url === "string" ? result.url : row.target.url,
          publishedAt: row.target.publishedAt ?? now,
          confirmationSource: verification?.status === "verified" ? "provider_verify" : "publish_response",
          verifiedAt: verification?.status === "verified" ? now : row.target.verifiedAt,
          updatedAt: now,
        })
        .where(and(eq(postTargets.postKey, row.target.postKey), eq(postTargets.target, row.target.target)))
        .run();
    });
    if (row.job.postId != null) reconcilePublication(backendDb, row.job.postId);
    recordDomainEvent(backendDb, {
      ref: row.target.postKey,
      target: row.target.target,
      type: "publish.job.reconciled",
      severity: "info",
      message: `${row.target.target} publication was confirmed`,
      details: { job_id: row.job.jobId, external_id: externalId, confirmation_source: verification?.status ?? "stored_response" },
    });
    resolved += 1;
  }

  const videos = backendDb.db
    .select({ target: videoTargets, draft: videoDrafts })
    .from(videoTargets)
    .innerJoin(videoDrafts, eq(videoDrafts.id, videoTargets.videoDraftId))
    .where(eq(videoTargets.status, "verification_required"))
    .all();
  for (const row of videos) {
    checked += 1;
    let confirmation: { externalId?: string | null; url?: string | null } | null = null;
    try {
      if (row.target.deliveryProvider === "zernio" && row.target.providerPostId) {
        const verified = await verifyZernioPost(config, row.target.providerPostId);
        confirmation = { externalId: verified.externalId, url: verified.url };
      } else if (row.target.target === "youtube_shorts" && row.target.externalId) {
        const verified = await verifyYouTubeVideo(config, row.target.externalId, row.draft.locale === "en" ? "en" : "ru");
        confirmation = { externalId: verified.id, url: verified.url };
      }
    } catch {
      continue;
    }
    if (!confirmation) continue;
    const now = new Date().toISOString();
    backendDb.db.transaction((tx) => {
      tx.update(videoTargets)
        .set({
          status: "published",
          externalId: confirmation?.externalId ?? row.target.externalId,
          externalUrl: confirmation?.url ?? row.target.externalUrl,
          lastError: null,
          publishedAt: row.target.publishedAt ?? now,
          confirmationSource: "provider_verify",
          verifiedAt: now,
          updatedAt: now,
        })
        .where(and(eq(videoTargets.id, row.target.id), eq(videoTargets.status, "verification_required")))
        .run();
      tx.update(videoJobs)
        .set({ status: "completed", lastError: null, lockedAt: null, lockedBy: null, updatedAt: now })
        .where(and(eq(videoJobs.videoTargetId, row.target.id), eq(videoJobs.status, "verification_required")))
        .run();
    });
    refreshVideoDraftStatus(backendDb, row.target.videoDraftId, config.VIDEO_MEDIA_RETENTION_HOURS);
    recordDomainEvent(backendDb, {
      ref: `video:${row.target.videoDraftId}`,
      target: row.target.target,
      type: "video.target.reconciled",
      severity: "info",
      message: `${row.target.target} video publication was confirmed`,
      details: { videoTargetId: row.target.id, confirmation_source: "provider_verify" },
    });
    resolved += 1;
  }

  const unresolvedTimes = [
    ...backendDb.db
      .select({ updatedAt: publishJobs.updatedAt })
      .from(publishJobs)
      .where(eq(publishJobs.status, "verification_required"))
      .all(),
    ...backendDb.db
      .select({ updatedAt: videoTargets.updatedAt })
      .from(videoTargets)
      .where(eq(videoTargets.status, "verification_required"))
      .all(),
  ]
    .map((row) => row.updatedAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  if (unresolvedTimes.length) {
    recordDomainEvent(backendDb, {
      type: "studio.notification.publication_verification_required",
      severity: "warn",
      message: `${unresolvedTimes.length} publication(s) still require verification; oldest since ${unresolvedTimes[0]}`,
      details: { count: unresolvedTimes.length, oldest_at: unresolvedTimes[0] },
      cooldownSeconds: config.ALERT_COOLDOWN_SECONDS,
    });
  }
  return { checked, resolved, unresolved: unresolvedTimes.length, oldestAt: unresolvedTimes[0] ?? null };
}
