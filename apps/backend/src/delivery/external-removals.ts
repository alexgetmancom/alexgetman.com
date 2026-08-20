import { and, desc, eq, isNull } from "drizzle-orm";
import { targetLocale } from "../botTargets.js";
import { type BackendDb, type UnsafeBackendDb, unsafeDb } from "../db/client.js";
import { publicationTargets, publishJobs } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { createPlatformAdapters } from "./platform-adapters.js";
import type { DeliveryRemove } from "./ports.js";

type RemovalOptions = { publicationKey: string; target?: string; locale?: "ru" | "en" };
type PublishedTarget = typeof publicationTargets.$inferSelect;

export type TargetRemovalResult = {
  target: string;
  ok: boolean;
  skipped?: boolean;
  stale?: boolean;
  deleted?: number;
  remaining?: number;
  error?: string;
};

export type TargetRemovalAttempt = {
  row: PublishedTarget;
  outcome: RemovalOutcome | { skipped: true; error: string } | { failed: true; error: string };
};

/** Removes published remote objects before a controlled replacement.  Every result is
 * returned to Operations (and hence the audit log); unsupported targets are explicit
 * skips rather than silently treated as successful deletions. */
export async function attemptPublishedTargetRemovals(
  backendDb: BackendDb,
  config: BackendConfig,
  options: RemovalOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<TargetRemovalAttempt[]> {
  const rows = unsafeDb(backendDb)
    .db.select()
    .from(publicationTargets)
    .where(and(eq(publicationTargets.publicationKey, options.publicationKey), eq(publicationTargets.status, "published")))
    .all()
    .filter((row) => !options.target || row.target === options.target)
    .filter((row) => !options.locale || targetLocale(row.target) === options.locale);
  const attempts: TargetRemovalAttempt[] = [];
  const adapters = createPlatformAdapters(config, fetchImpl);
  for (const row of rows) {
    try {
      const ids = row.externalIdsJson?.length ? row.externalIdsJson : row.externalId ? [row.externalId] : [];
      if (!ids.length) {
        attempts.push({ row, outcome: { skipped: true, error: "missing external id" } });
        continue;
      }
      const remove = adapters[row.target]?.remove;
      if (!remove) throw new Error(`remote deletion is not supported for ${row.target}`);
      attempts.push({ row, outcome: await removeTarget(ids, remove) });
    } catch (error) {
      attempts.push({ row, outcome: { failed: true, error: error instanceof Error ? error.message : String(error) } });
    }
  }
  return attempts;
}

/** Commits only remote outcomes whose target still names the object that was
 * acted on. The caller runs this beside requeue and audit in one transaction. */
export function settlePublishedTargetRemovals(
  db: UnsafeBackendDb["db"],
  attempts: TargetRemovalAttempt[],
  now = new Date().toISOString(),
): TargetRemovalResult[] {
  return attempts.map(({ row, outcome }) => {
    if ("skipped" in outcome) return { target: row.target, ok: false, skipped: true, error: outcome.error };
    if ("failed" in outcome) return { target: row.target, ok: false, error: outcome.error };
    const sameRemoteObject = and(
      eq(publicationTargets.publicationKey, row.publicationKey),
      eq(publicationTargets.target, row.target),
      eq(publicationTargets.status, "published"),
      row.externalId == null ? isNull(publicationTargets.externalId) : eq(publicationTargets.externalId, row.externalId),
    );
    const { deleted, remaining, error } = outcome;
    const updated = remaining.length
      ? db
          .update(publicationTargets)
          .set({
            externalId: remaining[0] ?? null,
            externalIdsJson: remaining,
            error: error ?? "partial remote deletion",
            updatedAt: now,
            rawJson: JSON.stringify({ deleted, remaining }),
          })
          .where(sameRemoteObject)
          .returning({ target: publicationTargets.target })
          .get()
      : db
          .update(publicationTargets)
          .set({
            status: "deleted",
            externalId: null,
            externalIdsJson: null,
            url: null,
            error: null,
            publishedAt: null,
            verifiedAt: null,
            updatedAt: now,
            rawJson: JSON.stringify({ deleted: true, ids: deleted }),
          })
          .where(sameRemoteObject)
          .returning({ target: publicationTargets.target })
          .get();
    if (!updated)
      return {
        target: row.target,
        ok: false,
        stale: true,
        deleted: deleted.length,
        remaining: remaining.length,
        error: "target changed while remote deletion was in flight",
      };
    if (!remaining.length) cancelDeletedPublishJob(db, row, now);
    return remaining.length
      ? { target: row.target, ok: false, deleted: deleted.length, remaining: remaining.length, ...(error ? { error } : {}) }
      : { target: row.target, ok: true, deleted: deleted.length };
  });
}

function cancelDeletedPublishJob(db: UnsafeBackendDb["db"], target: PublishedTarget, now: string): void {
  const job = db
    .select({ jobId: publishJobs.jobId, status: publishJobs.status })
    .from(publishJobs)
    .where(and(eq(publishJobs.publicationKey, target.publicationKey), eq(publishJobs.target, target.target)))
    .orderBy(desc(publishJobs.jobId))
    .get();
  if (job?.status !== "published") return;
  db.update(publishJobs)
    .set({ status: "cancelled", currentPhase: null, lockedBy: null, lockedAt: null, nextAttemptAt: null, lastError: null, updatedAt: now })
    .where(and(eq(publishJobs.jobId, job.jobId), eq(publishJobs.status, "published")))
    .run();
}

type RemovalOutcome = { deleted: string[]; remaining: string[]; error?: string };

/** Deletes every id it was given, rather than stopping at the first failure:
 * the ones behind it are the tail of a split post, and abandoning them leaves a
 * publication half-visible with no record of which half. */
async function removeTarget(ids: string[], remove: DeliveryRemove): Promise<RemovalOutcome> {
  const deleted: string[] = [];
  const remaining: string[] = [];
  let error: string | undefined;
  for (const id of ids) {
    try {
      await remove(id);
      deleted.push(id);
    } catch (failure) {
      remaining.push(id);
      error ??= failure instanceof Error ? failure.message : String(failure);
    }
  }
  return { deleted, remaining, ...(error ? { error } : {}) };
}
