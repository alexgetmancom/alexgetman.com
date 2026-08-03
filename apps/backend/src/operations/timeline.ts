import { asc, eq } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { postEvents, postTargets, publishJobs } from "../db/schema.js";
import { jsonObject } from "../json.js";

export function publicationTimeline(backendDb: BackendDb, ref: string): Record<string, unknown> {
  if (!/^post:\d+$/.test(ref)) throw new Error("--ref must look like post:106");
  const events = backendDb.db
    .select()
    .from(postEvents)
    .where(eq(postEvents.postKey, ref))
    .orderBy(asc(postEvents.createdAt), asc(postEvents.id))
    .all()
    .map((event) => ({
      at: event.createdAt,
      severity: event.severity,
      type: event.eventType,
      target: event.target,
      message: event.message,
      details: jsonObject(event.detailsJson),
    }));
  const jobs = backendDb.db
    .select({
      jobId: publishJobs.jobId,
      target: publishJobs.target,
      status: publishJobs.status,
      attemptCount: publishJobs.attemptCount,
      publishAt: publishJobs.publishAt,
      createdAt: publishJobs.createdAt,
      lockedAt: publishJobs.lockedAt,
      updatedAt: publishJobs.updatedAt,
      lastError: publishJobs.lastError,
    })
    .from(publishJobs)
    .where(eq(publishJobs.postKey, ref))
    .orderBy(asc(publishJobs.createdAt), asc(publishJobs.jobId))
    .all()
    .map((job) => ({ ...job, durationMs: elapsed(job.lockedAt ?? job.createdAt, job.updatedAt) }));
  const targets = backendDb.db
    .select({
      target: postTargets.target,
      status: postTargets.status,
      url: postTargets.url,
      error: postTargets.error,
      publishedAt: postTargets.publishedAt,
      updatedAt: postTargets.updatedAt,
    })
    .from(postTargets)
    .where(eq(postTargets.postKey, ref))
    .orderBy(postTargets.target)
    .all();
  return { ref, jobs, targets, events };
}

function elapsed(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
