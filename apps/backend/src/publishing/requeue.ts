import { and, desc, eq } from "drizzle-orm";
import { isSiteTarget, targetLocale } from "../botTargets.js";
import { textLocale } from "../content/text-locale.js";
import { type BackendDb, type UnsafeBackendDb, unsafeDb } from "../db/client.js";
import { publications, publicationTargets, publishJobs, siteJobs } from "../db/schema.js";
import { requeuedPostTarget, requeuedPublishJobColumns } from "./job-policy.js";
import { localizeTargetPayload } from "./payload.js";
import { insertEvent } from "./queue-state.js";

/**
 * The one way a publication target goes back into the queue.
 *
 * Studio's retry button and `ops retry` used to carry a copy each — one inside
 * a persistence adapter, one in Operations — and they had already drifted on
 * the question that matters: whether a target whose provider call may have
 * landed can be published again. It cannot, and saying so once is the point of
 * this module.
 */
export type RequeueResult = {
  target: string;
  outcome: "requeued" | "already_queued" | "not_retryable";
  status: string | null;
  /** Why a target was left alone when the state alone does not say it. */
  reason?: "empty" | "language";
};

/** The queue is the last place a wrong-language publication can be stopped, and
 * the only place on this path: a requeue builds no draft, so preflight never
 * sees it. Publications stored before the fallbacks were removed still carry
 * the Russian text in their English field, and re-publishing one would put it
 * in front of the English audience — again, and this time on purpose. */
function unpublishable(payload: Record<string, unknown>, target: string): RequeueResult["reason"] | null {
  const text = String(payload.text ?? "").trim();
  const media = payload.media;
  if (!text && !(Array.isArray(media) && media.length > 0)) return "empty";
  const locale = targetLocale(target);
  if (!locale || !text) return null;
  const written = textLocale(text);
  return written && written !== locale ? "language" : null;
}

/** An operator restores a target whatever state it reached — including one
 * deleted from the platform on purpose. The two states missing here belong to
 * someone else: `publishing` to a live worker, `verification_required` to
 * reconciliation. */
export const RETRY_UNLESS_HELD = ["queued", "failed", "cancelled", "skipped", "published"] as const;

export type RequeueScope = { postId: number | null; publicationKey: string; messageId: number | null };

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
  mirrorRequeuedTarget(tx, scope.publicationKey, target, now);
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
  const whereRef =
    scope.postId != null ? eq(publishJobs.publicationId, scope.postId) : eq(publishJobs.publicationKey, scope.publicationKey);
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
  const payload = localizeTargetPayload(source(), target);
  const refused = unpublishable(payload, target);
  if (refused) return { target, outcome: "not_retryable", status: row.status, reason: refused };
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
  mirrorRequeuedTarget(tx, row.publicationKey ?? scope.publicationKey, target, now);
  return { target, outcome: "requeued", status: row.status };
}

function createPublishJob(tx: RequeueDb, scope: RequeueScope, target: string, source: Record<string, unknown>, now: string): RequeueResult {
  const payload = localizeTargetPayload(source, target);
  if (scope.postId == null) return { target, outcome: "not_retryable", status: null };
  // `localizeTargetPayload` always returns its keys, so the `Object.keys(...)
  // === 0` this used to test was never the empty case, and a target whose
  // language the publication has nothing in got a job all the same.
  const refused = unpublishable(payload, target);
  if (refused) return { target, outcome: "not_retryable", status: null, reason: refused };
  tx.insert(publishJobs)
    .values({
      publicationId: scope.postId,
      publicationKey: scope.publicationKey,
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
  mirrorRequeuedTarget(tx, scope.publicationKey, target, now);
  return { target, outcome: "requeued", status: null };
}

function mirrorRequeuedTarget(tx: RequeueDb, publicationKey: string, target: string, now: string): void {
  const previous = tx
    .select({ status: publicationTargets.status, externalId: publicationTargets.externalId, url: publicationTargets.url })
    .from(publicationTargets)
    .where(and(eq(publicationTargets.publicationKey, publicationKey), eq(publicationTargets.target, target)))
    .get();
  const mirrored = requeuedPostTarget(publicationKey, target, now);
  tx.insert(publicationTargets)
    .values(mirrored.values)
    .onConflictDoUpdate({ target: [publicationTargets.publicationKey, publicationTargets.target], set: mirrored.patch })
    .run();
  // The row is about to describe a different remote object, so it drops the id
  // of the one it named. When that object was live, dropping the id is the only
  // record of it there was: `verify`, `delete` and `purge` all aim by that id,
  // and none of them could ever reach it again. The journal keeps it, in the
  // same transaction as the requeue that forgot it.
  if (previous?.status !== "published" || !previous.externalId) return;
  insertEvent(
    tx,
    publicationKey,
    target,
    "publish.target.identity_dropped",
    "warn",
    `${target} was requeued while still published; its previous post is no longer referenced`,
    { external_id: previous.externalId, url: previous.url },
    now,
  );
}
