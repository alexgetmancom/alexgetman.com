import { and, eq, isNull } from "drizzle-orm";
import { targetLocale } from "../botTargets.js";
import { type BackendDb, type UnsafeBackendDb, unsafeDb } from "../db/client.js";
import { postTargets } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { createPlatformAdapters } from "./platform-adapters.js";
import type { DeliveryRemove } from "./ports.js";

type RemovalOptions = { postKey: string; target?: string; locale?: "ru" | "en" };
type PublishedTarget = typeof postTargets.$inferSelect;

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
    .from(postTargets)
    .where(and(eq(postTargets.postKey, options.postKey), eq(postTargets.status, "published")))
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
      eq(postTargets.postKey, row.postKey),
      eq(postTargets.target, row.target),
      eq(postTargets.status, "published"),
      row.externalId == null ? isNull(postTargets.externalId) : eq(postTargets.externalId, row.externalId),
    );
    const { deleted, remaining, error } = outcome;
    const updated = remaining.length
      ? db
          .update(postTargets)
          .set({
            externalId: remaining[0] ?? null,
            externalIdsJson: remaining,
            error: error ?? "partial remote deletion",
            updatedAt: now,
            rawJson: JSON.stringify({ deleted, remaining }),
          })
          .where(sameRemoteObject)
          .returning({ target: postTargets.target })
          .get()
      : db
          .update(postTargets)
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
          .returning({ target: postTargets.target })
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
    return remaining.length
      ? { target: row.target, ok: false, deleted: deleted.length, remaining: remaining.length, ...(error ? { error } : {}) }
      : { target: row.target, ok: true, deleted: deleted.length };
  });
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
