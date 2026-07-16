import { asc, desc, eq, or, sql } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
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
import { parseJsonValue } from "../json.js";
import { pipelineStatusPayload } from "./read-model.js";

export function commandCenterPayload(config: BackendConfig, backendDb: BackendDb) {
  const queue = backendDb.db
    .select({ status: publishJobs.status, count: sql<number>`count(*)` })
    .from(publishJobs)
    .groupBy(publishJobs.status)
    .orderBy(asc(publishJobs.status))
    .all();
  const targets = backendDb.db
    .select({
      target: postTargets.target,
      status: postTargets.status,
      count: sql<number>`count(*)`,
    })
    .from(postTargets)
    .groupBy(postTargets.target, postTargets.status)
    .orderBy(asc(postTargets.target), asc(postTargets.status))
    .all();
  const events = backendDb.db.select().from(postEvents).orderBy(desc(postEvents.createdAt), desc(postEvents.id)).limit(50).all();
  const jobs = backendDb.db.select().from(publishJobs).orderBy(desc(publishJobs.updatedAt), desc(publishJobs.jobId)).limit(100).all();
  const draftRows = backendDb.db.select().from(drafts).orderBy(desc(drafts.updatedAt), desc(drafts.id)).limit(50).all();
  const credentials = backendDb.db.select().from(credentialChecks).orderBy(desc(credentialChecks.lastCheckedAt)).limit(100).all();
  const lifecycle = backendDb.db.select().from(postLifecycle).orderBy(desc(postLifecycle.updatedAt)).limit(100).all();
  const actions = backendDb.db.select().from(opsActions).orderBy(desc(opsActions.createdAt), desc(opsActions.actionId)).limit(100).all();
  return {
    generatedAt: new Date().toISOString(),
    pipeline: pipelineStatusPayload(config, backendDb),
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
      details: parseJsonValue(event.detailsJson),
      createdAt: event.createdAt,
      ackedAt: event.ackedAt,
    })),
    videoRevision: backendDb.sqlite
      .prepare(
        "SELECT MAX(value) AS value FROM (SELECT MAX(updated_at) AS value FROM video_drafts UNION ALL SELECT MAX(sampled_at) AS value FROM video_metric_snapshots)",
      )
      .get() as { value: string | null },
  };
}

export function postDebugPayload(backendDb: BackendDb, ref: string) {
  const postKey = resolvePostKey(backendDb, ref);
  if (!postKey) return null;
  const post = backendDb.db.select().from(posts).where(eq(posts.postKey, postKey)).get();
  const targets = backendDb.db.select().from(postTargets).where(eq(postTargets.postKey, postKey)).orderBy(asc(postTargets.target)).all();
  const metrics = backendDb.db
    .select()
    .from(postMetrics)
    .where(eq(postMetrics.postKey, postKey))
    .orderBy(asc(postMetrics.target), asc(postMetrics.metricName))
    .all();
  const schedule = backendDb.db
    .select()
    .from(metricSchedule)
    .where(eq(metricSchedule.postKey, postKey))
    .orderBy(asc(metricSchedule.target))
    .all();
  const id = numericRef(ref);
  const jobs = backendDb.db
    .select()
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
  const post = backendDb.db
    .select({ postKey: posts.postKey })
    .from(posts)
    .where(or(eq(posts.postId, id), eq(posts.postKey, `post:${id}`), eq(posts.messageId, id)))
    .get();
  if (post?.postKey) return post.postKey;
  const job = backendDb.db
    .select({ postKey: publishJobs.postKey, postId: publishJobs.postId })
    .from(publishJobs)
    .where(or(eq(publishJobs.messageId, id), eq(publishJobs.postId, id)))
    .orderBy(desc(publishJobs.jobId))
    .get();
  return job?.postKey ?? (job?.postId != null ? `post:${job.postId}` : `post:${id}`);
}

function numericRef(ref: string): number | null {
  return /^\d+$/.test(ref) ? Number(ref) : null;
}
