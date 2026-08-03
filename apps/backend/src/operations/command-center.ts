import { asc, desc, eq, or, sql } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import {
  credentialChecks,
  drafts,
  metricSchedule,
  opsActions,
  postEvents,
  postLifecycle,
  postMetrics,
  posts,
  postTargets,
  publishJobs,
} from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { capabilityReport } from "../observability/capabilities.js";
import { pipelineUpdatedAt } from "./read-model.js";

export function commandCenterPayload(config: BackendConfig, backendDb: BackendDb) {
  const queue = unsafeDb(backendDb)
    .db.select({ status: publishJobs.status, count: sql<number>`count(*)` })
    .from(publishJobs)
    .groupBy(publishJobs.status)
    .orderBy(asc(publishJobs.status))
    .all();
  const targets = unsafeDb(backendDb)
    .db.select({
      target: postTargets.target,
      status: postTargets.status,
      count: sql<number>`count(*)`,
    })
    .from(postTargets)
    .groupBy(postTargets.target, postTargets.status)
    .orderBy(asc(postTargets.target), asc(postTargets.status))
    .all();
  const events = unsafeDb(backendDb)
    .db.select({
      id: postEvents.id,
      postKey: postEvents.postKey,
      eventType: postEvents.eventType,
      severity: postEvents.severity,
      target: postEvents.target,
      message: postEvents.message,
      createdAt: postEvents.createdAt,
      ackedAt: postEvents.ackedAt,
    })
    .from(postEvents)
    .orderBy(desc(postEvents.createdAt), desc(postEvents.id))
    .limit(50)
    .all();
  const jobs = unsafeDb(backendDb)
    .db.select({
      jobId: publishJobs.jobId,
      postId: publishJobs.postId,
      messageId: publishJobs.messageId,
      target: publishJobs.target,
      status: publishJobs.status,
      attemptCount: publishJobs.attemptCount,
      publishAt: publishJobs.publishAt,
      nextAttemptAt: publishJobs.nextAttemptAt,
      lastError: publishJobs.lastError,
      updatedAt: publishJobs.updatedAt,
    })
    .from(publishJobs)
    .orderBy(desc(publishJobs.updatedAt), desc(publishJobs.jobId))
    .limit(100)
    .all();
  const draftRows = unsafeDb(backendDb)
    .db.select({
      id: drafts.id,
      status: drafts.status,
      textRu: drafts.textRu,
      scheduledAt: drafts.scheduledAt,
      scheduledEnAt: drafts.scheduledEnAt,
      channelMessageId: drafts.channelMessageId,
      updatedAt: drafts.updatedAt,
    })
    .from(drafts)
    .orderBy(desc(drafts.updatedAt), desc(drafts.id))
    .limit(50)
    .all();
  const activeCapabilityTargets = new Set(capabilityReport(config, backendDb).map((capability) => capability.target));
  const credentials = unsafeDb(backendDb)
    .db.select({
      target: credentialChecks.target,
      status: credentialChecks.status,
      missingEnvJson: credentialChecks.missingEnvJson,
      lastError: credentialChecks.lastError,
      lastCheckedAt: credentialChecks.lastCheckedAt,
    })
    .from(credentialChecks)
    .orderBy(desc(credentialChecks.lastCheckedAt))
    .all()
    .filter((credential) => activeCapabilityTargets.has(credential.target))
    .slice(0, 100);
  const lifecycle = unsafeDb(backendDb)
    .db.select({
      postKey: postLifecycle.postKey,
      state: postLifecycle.state,
      reason: postLifecycle.reason,
      updatedAt: postLifecycle.updatedAt,
    })
    .from(postLifecycle)
    .orderBy(desc(postLifecycle.updatedAt))
    .limit(100)
    .all();
  const actions = unsafeDb(backendDb)
    .db.select({
      actionId: opsActions.actionId,
      actorType: opsActions.actorType,
      action: opsActions.action,
      messageId: opsActions.messageId,
      target: opsActions.target,
      status: opsActions.status,
      createdAt: opsActions.createdAt,
      completedAt: opsActions.completedAt,
    })
    .from(opsActions)
    .orderBy(desc(opsActions.createdAt), desc(opsActions.actionId))
    .limit(100)
    .all();
  const recentMetrics = unsafeDb(backendDb)
    .db.select({
      postKey: postMetrics.postKey,
      target: postMetrics.target,
      metricName: postMetrics.metricName,
      value: postMetrics.value,
      source: postMetrics.source,
      sampledAt: postMetrics.sampledAt,
      error: postMetrics.error,
      messageId: posts.messageId,
      postUrl: sql<string | null>`coalesce(${posts.siteEnPath}, ${posts.siteRuPath}, ${posts.telegramUrl})`,
    })
    .from(postMetrics)
    .leftJoin(posts, eq(posts.postKey, postMetrics.postKey))
    .orderBy(desc(postMetrics.sampledAt), asc(postMetrics.postKey), asc(postMetrics.target), asc(postMetrics.metricName))
    .limit(100)
    .all();
  const fingerprint = commandCenterFingerprint(backendDb);
  return {
    generatedAt: new Date().toISOString(),
    // The dashboard only needs current metric issues here. Full post history,
    // samples and provider raw payloads belong to the period read model and
    // /api/post-debug, not to this always-on operations payload.
    pipeline: { updated_at: fingerprint.pipelineUpdatedAt, metrics: { recent: recentMetrics } },
    queue,
    targets,
    jobs,
    drafts: draftRows,
    credentials,
    lifecycle,
    actions,
    events: events.map((event) => ({
      id: event.id,
      postKey: event.postKey,
      eventType: event.eventType,
      severity: event.severity,
      target: event.target,
      message: event.message,
      createdAt: event.createdAt,
      ackedAt: event.ackedAt,
    })),
    videoRevision: { value: fingerprint.videoRevision },
  };
}

export type CommandCenterAttention = {
  hasFailedJob: boolean;
  hasCredentialIssue: boolean;
  hasMetricIssue: boolean;
};

/** Small overview-only projection. Full queue and diagnostic rows stay behind their panels. */
export function commandCenterAttention(config: BackendConfig, backendDb: BackendDb): CommandCenterAttention {
  const failedJob = unsafeDb(backendDb)
    .db.select({ status: publishJobs.status })
    .from(publishJobs)
    .orderBy(desc(publishJobs.updatedAt), desc(publishJobs.jobId))
    .limit(100)
    .all()
    .some((job) => job.status === "failed");
  const activeCapabilityTargets = new Set(capabilityReport(config, backendDb).map((capability) => capability.target));
  const credentialIssue = unsafeDb(backendDb)
    .db.select({ target: credentialChecks.target, status: credentialChecks.status })
    .from(credentialChecks)
    .orderBy(desc(credentialChecks.lastCheckedAt))
    .all()
    .some((credential) => activeCapabilityTargets.has(credential.target) && credential.status !== "ok" && credential.status !== "ready");
  const metricIssue = unsafeDb(backendDb)
    .db.select({ error: postMetrics.error })
    .from(postMetrics)
    .orderBy(desc(postMetrics.sampledAt))
    .limit(100)
    .all()
    .some((metric) => Boolean(metric.error));
  return { hasFailedJob: failedJob, hasCredentialIssue: credentialIssue, hasMetricIssue: metricIssue };
}

export type CommandCenterFingerprint = {
  pipelineUpdatedAt: string | null;
  latestJobUpdatedAt: string | null;
  latestEventAt: string | null;
  videoRevision: string | null;
};

export function commandCenterFingerprint(backendDb: BackendDb): CommandCenterFingerprint {
  const revisions = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT
         (SELECT MAX(updated_at) FROM publish_jobs) AS latestJobUpdatedAt,
         (SELECT MAX(created_at) FROM post_events) AS latestEventAt,
         (SELECT MAX(value) FROM (
           SELECT MAX(updated_at) AS value FROM video_drafts
           UNION ALL SELECT MAX(sampled_at) FROM video_metric_snapshots
         )) AS videoRevision`,
    )
    .get() as Omit<CommandCenterFingerprint, "pipelineUpdatedAt">;
  return { pipelineUpdatedAt: pipelineUpdatedAt(backendDb), ...revisions };
}

export function postDebugPayload(backendDb: BackendDb, ref: string) {
  const postKey = resolvePostKey(backendDb, ref);
  if (!postKey) return null;
  const post = unsafeDb(backendDb).db.select().from(posts).where(eq(posts.postKey, postKey)).get();
  const targets = unsafeDb(backendDb)
    .db.select()
    .from(postTargets)
    .where(eq(postTargets.postKey, postKey))
    .orderBy(asc(postTargets.target))
    .all();
  const metrics = unsafeDb(backendDb)
    .db.select()
    .from(postMetrics)
    .where(eq(postMetrics.postKey, postKey))
    .orderBy(asc(postMetrics.target), asc(postMetrics.metricName))
    .all();
  const schedule = unsafeDb(backendDb)
    .db.select()
    .from(metricSchedule)
    .where(eq(metricSchedule.postKey, postKey))
    .orderBy(asc(metricSchedule.target))
    .all();
  const id = numericRef(ref);
  const jobs = unsafeDb(backendDb)
    .db.select()
    .from(publishJobs)
    .where(
      or(
        eq(publishJobs.postKey, postKey),
        id == null ? sql`false` : eq(publishJobs.postId, id),
        id == null ? sql`false` : eq(publishJobs.messageId, id),
      ),
    )
    .orderBy(desc(publishJobs.jobId))
    .all();
  return {
    ref: { input: ref, postKey },
    post: post ?? null,
    targets,
    metrics,
    schedule,
    jobs,
  };
}

function resolvePostKey(backendDb: BackendDb, ref: string): string | null {
  const value = ref.trim();
  if (!value) return null;
  if (value.startsWith("post:")) return value;
  const id = numericRef(value);
  if (id == null) return value;
  const post = unsafeDb(backendDb)
    .db.select({ postKey: posts.postKey })
    .from(posts)
    .where(or(eq(posts.postId, id), eq(posts.postKey, `post:${id}`), eq(posts.messageId, id)))
    .get();
  if (post?.postKey) return post.postKey;
  const job = unsafeDb(backendDb)
    .db.select({ postKey: publishJobs.postKey, postId: publishJobs.postId })
    .from(publishJobs)
    .where(or(eq(publishJobs.messageId, id), eq(publishJobs.postId, id)))
    .orderBy(desc(publishJobs.jobId))
    .get();
  return job?.postKey ?? (job?.postId != null ? `post:${job.postId}` : `post:${id}`);
}

function numericRef(ref: string): number | null {
  return /^\d+$/.test(ref) ? Number(ref) : null;
}
