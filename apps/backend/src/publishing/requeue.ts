import { and, desc, eq } from "drizzle-orm";
import { isSiteTarget } from "../botTargets.js";
import { type BackendDb, type UnsafeBackendDb, unsafeDb } from "../db/client.js";
import { postTargets, publications, publishJobs, siteJobs } from "../db/schema.js";
import { jsonObject } from "../json.js";
import { requeuedPostTarget, requeuedPublishJobColumns } from "./job-policy.js";
import { localizeTargetPayload } from "./payload.js";

/**
 * The one way a publication target goes back into the queue.
 *
 * Studio's retry button and `ops retry` used to carry a copy each — one inside
 * a persistence adapter, one in Operations — and they had already drifted on
 * the question that matters: whether a target whose provider call may have
 * landed can be published again. It cannot, and saying so once is the point of
 * this module.
 */
export type RequeueResult = { target: string; outcome: "requeued" | "already_queued" | "not_retryable"; status: string | null };

/** Studio retries what failed. `verification_required` is not failure: the
 * provider may be holding the post, and republishing it is how one publication
 * becomes two. Reconciliation settles that state, and moves it to `failed`
 * once it has given up — at which point this path applies again. */
export const RETRY_AFTER_FAILURE = ["failed"] as const;

/** An operator restores a target whatever state it reached — including one
 * deleted from the platform on purpose. The two states missing here belong to
 * someone else: `publishing` to a live worker, `verification_required` to
 * reconciliation. */
export const RETRY_UNLESS_HELD = ["queued", "failed", "cancelled", "skipped", "published"] as const;

export type RequeueScope = { postId: number | null; postKey: string; messageId: number | null };

type RequeueOptions = {
  /** Job states this caller may pull back. */
  from: readonly string[];
  /** The durable publication payload, read at most once and only when a job is
   * actually requeued. */
  source: () => Record<string, unknown>;
  /** Create a publish job for a target that never had one. Only an operator
   * naming a single target asks for this; Studio retries what exists. */
  createMissing?: boolean;
};

export function requeuePublicationTargets(
  backendDb: BackendDb,
  scope: RequeueScope,
  targets: string[],
  options: RequeueOptions,
): RequeueResult[] {
  return unsafeDb(backendDb).db.transaction((tx) => requeuePublicationTargetsTx(tx, scope, targets, options));
}

/** Same state transition for callers already committing a larger operation. */
export function requeuePublicationTargetsTx(
  db: UnsafeBackendDb["db"],
  scope: RequeueScope,
  targets: string[],
  options: RequeueOptions,
): RequeueResult[] {
  const now = new Date().toISOString();
  const results: RequeueResult[] = [];
  let cachedSource: Record<string, unknown> | null = null;
  const source = (): Record<string, unknown> => (cachedSource ??= options.source());

  for (const target of [...new Set(targets)]) {
    results.push(
      isSiteTarget(target)
        ? requeueSiteTarget(db, scope, target, options, now)
        : requeueSocialTarget(db, scope, target, options, source, now),
    );
  }
  // Only when something is actually going out again: a retry that found every
  // target held changed nothing, and moving the publication back to
  // `scheduled` would tell the Command Center a delivery was under way.
  if (scope.postId != null && results.some((result) => result.outcome === "requeued"))
    db.update(publications).set({ status: "scheduled", updatedAt: now }).where(eq(publications.postId, scope.postId)).run();
  return results;
}

type Transaction = Parameters<Parameters<ReturnType<typeof unsafeDb>["db"]["transaction"]>[0]>[0];
type RequeueDb = UnsafeBackendDb["db"] | Transaction;

/** The site is rendered from `siteJobs`, keyed by a publish reason; every other
 * target is delivered from `publishJobs`, keyed by the target. Routing them
 * together used to manufacture a publishJobs row for `site_ru`, which no
 * publisher serves. */
function requeueSiteTarget(tx: RequeueDb, scope: RequeueScope, target: string, options: RequeueOptions, now: string): RequeueResult {
  if (scope.postId == null && scope.messageId == null) return { target, outcome: "not_retryable", status: null };
  const whereRef = scope.postId != null ? eq(siteJobs.postId, scope.postId) : eq(siteJobs.messageId, scope.messageId as number);
  const row = tx
    .select()
    .from(siteJobs)
    .where(and(whereRef, eq(siteJobs.reason, target)))
    .orderBy(desc(siteJobs.jobId))
    .get();
  // Fabricating a site job is a different operation, and `ops repair-content`
  // already owns it.
  if (!row) return { target, outcome: "not_retryable", status: null };
  if (row.status === "queued") return { target, outcome: "already_queued", status: row.status };
  // The site is the one target where `verification_required` is retryable: it
  // means a rendered page could not be confirmed, and rendering it again
  // produces the same page. Nothing reaches an audience twice.
  if (!options.from.includes(row.status) && row.status !== "verification_required")
    return { target, outcome: "not_retryable", status: row.status };
  const requeued = tx
    .update(siteJobs)
    .set({ status: "queued", attemptCount: 0, nextAttemptAt: null, lockedBy: null, lockedAt: null, lastError: null, updatedAt: now })
    .where(and(eq(siteJobs.jobId, row.jobId), eq(siteJobs.status, row.status)))
    .returning({ jobId: siteJobs.jobId })
    .get();
  if (!requeued) return { target, outcome: "not_retryable", status: row.status };
  mirrorRequeuedTarget(tx, scope.postKey, target, now);
  return { target, outcome: "requeued", status: row.status };
}

function requeueSocialTarget(
  tx: RequeueDb,
  scope: RequeueScope,
  target: string,
  options: RequeueOptions,
  source: () => Record<string, unknown>,
  now: string,
): RequeueResult {
  const whereRef = scope.postId != null ? eq(publishJobs.postId, scope.postId) : eq(publishJobs.postKey, scope.postKey);
  const row = tx
    .select()
    .from(publishJobs)
    .where(and(whereRef, eq(publishJobs.target, target)))
    .orderBy(desc(publishJobs.jobId))
    .get();
  if (!row)
    return options.createMissing ? createPublishJob(tx, scope, target, source(), now) : { target, outcome: "not_retryable", status: null };
  if (row.status === "queued") return { target, outcome: "already_queued", status: row.status };
  if (!options.from.includes(row.status)) return { target, outcome: "not_retryable", status: row.status };
  const payload = localizeTargetPayload(pickPayload(source(), row.payloadJson), target);
  // Fenced on the status this decision was made from: a worker claiming the job
  // between the read and the write keeps it, rather than having its lock
  // cleared mid-publish and its post delivered twice by the next claim.
  const requeued = tx
    .update(publishJobs)
    .set(requeuedPublishJobColumns(payload, now))
    .where(and(eq(publishJobs.jobId, row.jobId), eq(publishJobs.status, row.status)))
    .returning({ jobId: publishJobs.jobId })
    .get();
  if (!requeued) return { target, outcome: "not_retryable", status: row.status };
  mirrorRequeuedTarget(tx, row.postKey ?? scope.postKey, target, now);
  return { target, outcome: "requeued", status: row.status };
}

function createPublishJob(tx: RequeueDb, scope: RequeueScope, target: string, source: Record<string, unknown>, now: string): RequeueResult {
  const payload = localizeTargetPayload(source, target);
  if (scope.postId == null || scope.messageId == null || Object.keys(payload).length === 0)
    return { target, outcome: "not_retryable", status: null };
  tx.insert(publishJobs)
    .values({
      postId: scope.postId,
      postKey: scope.postKey,
      messageId: scope.messageId,
      target,
      status: "queued",
      attemptCount: 0,
      publishAt: now,
      nextAttemptAt: null,
      lockedBy: null,
      lockedAt: null,
      payloadJson: payload,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  mirrorRequeuedTarget(tx, scope.postKey, target, now);
  return { target, outcome: "requeued", status: null };
}

/** The durable publication source, falling back to what the job last carried
 * for a publication that predates the source table. */
function pickPayload(source: Record<string, unknown>, payloadJson: unknown): Record<string, unknown> {
  return Object.keys(source).length > 0 ? source : jsonObject(payloadJson);
}

function mirrorRequeuedTarget(tx: RequeueDb, postKey: string, target: string, now: string): void {
  const mirrored = requeuedPostTarget(postKey, target, now);
  tx.insert(postTargets)
    .values(mirrored.values)
    .onConflictDoUpdate({ target: [postTargets.postKey, postTargets.target], set: mirrored.patch })
    .run();
}
