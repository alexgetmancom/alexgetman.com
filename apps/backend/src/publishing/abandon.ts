import { and, desc, eq } from "drizzle-orm";
import { isSiteTarget } from "../botTargets.js";
import { type BackendDb, type UnsafeBackendDb, unsafeDb } from "../db/client.js";
import { postTargets, publishJobs, siteJobs } from "../db/schema.js";
import { insertEvent } from "./queue-state.js";
import type { RequeueScope } from "./requeue.js";

/**
 * The one way a delivery target that did not land is given up on.
 *
 * A retry puts the target back in the queue; this says the publication is
 * finished without it. Nothing is sent, nothing is removed from a platform: the
 * job stops asking to be dealt with, and the publication can settle. Only a
 * target the operator was already being asked about qualifies -- `failed`, or
 * `verification_required`, which is ambiguous and settled here as such.
 */
export type AbandonResult = { target: string; outcome: "abandoned" | "not_abandonable"; status: string | null };

const ABANDONABLE_STATUSES = ["failed", "verification_required"];

export function abandonPublicationTargets(backendDb: BackendDb, scope: RequeueScope, targets: string[]): AbandonResult[] {
  const now = backendDb.clock.now().toISOString();
  return unsafeDb(backendDb).db.transaction((tx) =>
    [...new Set(targets)].map((target) =>
      isSiteTarget(target) ? abandonSiteTarget(tx, scope, target, now) : abandonSocialTarget(tx, scope, target, now),
    ),
  );
}

type Transaction = Parameters<Parameters<ReturnType<typeof unsafeDb>["db"]["transaction"]>[0]>[0];
type AbandonDb = UnsafeBackendDb["db"] | Transaction;

function abandonSiteTarget(tx: AbandonDb, scope: RequeueScope, target: string, now: string): AbandonResult {
  if (scope.postId == null && scope.messageId == null) return { target, outcome: "not_abandonable", status: null };
  const whereRef = scope.postId != null ? eq(siteJobs.postId, scope.postId) : eq(siteJobs.messageId, scope.messageId as number);
  const row = tx
    .select({ jobId: siteJobs.jobId, status: siteJobs.status })
    .from(siteJobs)
    .where(and(whereRef, eq(siteJobs.reason, target)))
    .orderBy(desc(siteJobs.jobId))
    .get();
  if (!row || !ABANDONABLE_STATUSES.includes(row.status)) return { target, outcome: "not_abandonable", status: row?.status ?? null };
  // Fenced on the status the decision was made from, so a worker or
  // reconciliation that moved the job in between keeps it.
  const abandoned = tx
    .update(siteJobs)
    .set({ status: "cancelled", nextAttemptAt: null, lockedBy: null, lockedAt: null, updatedAt: now })
    .where(and(eq(siteJobs.jobId, row.jobId), eq(siteJobs.status, row.status)))
    .returning({ jobId: siteJobs.jobId })
    .get();
  if (!abandoned) return { target, outcome: "not_abandonable", status: row.status };
  return settle(tx, scope.postKey, target, row.status, now);
}

function abandonSocialTarget(tx: AbandonDb, scope: RequeueScope, target: string, now: string): AbandonResult {
  const whereRef = scope.postId != null ? eq(publishJobs.postId, scope.postId) : eq(publishJobs.postKey, scope.postKey);
  const row = tx
    .select({ jobId: publishJobs.jobId, status: publishJobs.status, postKey: publishJobs.postKey })
    .from(publishJobs)
    .where(and(whereRef, eq(publishJobs.target, target)))
    .orderBy(desc(publishJobs.jobId))
    .get();
  if (!row || !ABANDONABLE_STATUSES.includes(row.status)) return { target, outcome: "not_abandonable", status: row?.status ?? null };
  const abandoned = tx
    .update(publishJobs)
    .set({ status: "cancelled", nextAttemptAt: null, lockedBy: null, lockedAt: null, currentPhase: null, updatedAt: now })
    .where(and(eq(publishJobs.jobId, row.jobId), eq(publishJobs.status, row.status)))
    .returning({ jobId: publishJobs.jobId })
    .get();
  if (!abandoned) return { target, outcome: "not_abandonable", status: row.status };
  return settle(tx, row.postKey ?? scope.postKey, target, row.status, now);
}

/** The mirrored target row and the journal entry, in the transaction that
 * abandoned the job: post_targets is what the Command Center and the bot read,
 * and an ambiguous target given up on is the one state worth reading back
 * later, so it is never only a status change. */
function settle(tx: AbandonDb, postKey: string, target: string, previousStatus: string, now: string): AbandonResult {
  tx.update(postTargets)
    .set({ status: "cancelled", updatedAt: now })
    .where(and(eq(postTargets.postKey, postKey), eq(postTargets.target, target)))
    .run();
  insertEvent(
    tx,
    postKey,
    target,
    "publish.target.abandoned",
    "warn",
    `${target} was abandoned by the operator and will not be published`,
    { previous_status: previousStatus },
    now,
  );
  return { target, outcome: "abandoned", status: previousStatus };
}
