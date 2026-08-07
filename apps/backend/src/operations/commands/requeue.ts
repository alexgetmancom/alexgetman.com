import { and, desc, eq } from "drizzle-orm";
import { targetLocale } from "../../botTargets.js";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { postTargets, publications, publishJobs } from "../../db/schema.js";
import { removePublishedTargets } from "../../delivery/external-removals.js";
import type { BackendConfig } from "../../foundation/config.js";
import { jsonObject } from "../../json.js";
import { requeuedPublishJobColumns } from "../../publishing/job-policy.js";
import { localizeTargetPayload } from "../../publishing/payload.js";
import { type ResolvedPublicationRef, sourcePayload } from "../publication-ref.js";

/** Restores queued Delivery work from its durable publication source. */
function requeuePublication(backendDb: BackendDb, ref: ResolvedPublicationRef, target?: string): Record<string, unknown> {
  const source = sourcePayload(backendDb, ref);
  const whereRef = ref.postId != null ? eq(publishJobs.postId, ref.postId) : eq(publishJobs.postKey, ref.postKey);
  const rows = unsafeDb(backendDb)
    .db.select()
    .from(publishJobs)
    .where(target ? and(whereRef, eq(publishJobs.target, target)) : whereRef)
    .orderBy(desc(publishJobs.jobId))
    .all();
  const latest = new Map<string, typeof publishJobs.$inferSelect>();
  for (const row of rows) if (!latest.has(row.target)) latest.set(row.target, row);
  if (latest.size === 0 && target) {
    const fallback = unsafeDb(backendDb).db.select().from(publishJobs).where(whereRef).orderBy(desc(publishJobs.updatedAt)).get();
    const payload = localizeTargetPayload(Object.keys(source).length > 0 ? source : jsonObject(fallback?.payloadJson), target);
    if (Object.keys(payload).length === 0) throw new Error("no publish jobs found");
    const now = new Date().toISOString();
    const inserted = unsafeDb(backendDb)
      .db.insert(publishJobs)
      .values({
        postId: ref.postId,
        postKey: ref.postKey,
        messageId: ref.messageId,
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
      .returning()
      .get();
    if (inserted) latest.set(target, inserted);
  }
  if (latest.size === 0) throw new Error("no publish jobs found");
  const now = new Date().toISOString();
  // Per-target outcome, not a flat name list: a target that already had a queued
  // job keeps its existing payload, so reporting it as "requeued" would tell the
  // operator the payload was regenerated from the durable source when it wasn't.
  const results: Array<{ target: string; outcome: "requeued" | "already_queued" | "publishing" }> = [];
  unsafeDb(backendDb).db.transaction((tx) => {
    for (const [targetId, row] of latest) {
      const existing = tx
        .select({ jobId: publishJobs.jobId })
        .from(publishJobs)
        .where(
          and(
            ref.postId != null ? eq(publishJobs.postId, ref.postId) : eq(publishJobs.postKey, ref.postKey),
            eq(publishJobs.target, targetId),
            eq(publishJobs.status, "queued"),
          ),
        )
        .get();
      // A job a worker currently holds is off limits. Flipping it to queued
      // clears the lock the worker checks before recording its result, so the
      // provider call it is in the middle of would go out, be discarded as a
      // lost lock, and then be published a second time by the next claim. A
      // worker that actually died is recovered by recoverStalePublishJobs once
      // its lock ages out; there is nothing for an operator to rescue here.
      if (!existing && row.status === "publishing") {
        results.push({ target: targetId, outcome: "publishing" });
        continue;
      }
      if (!existing) {
        const payload = localizeTargetPayload(Object.keys(source).length > 0 ? source : jsonObject(row.payloadJson), targetId);
        tx.update(publishJobs).set(requeuedPublishJobColumns(payload, now)).where(eq(publishJobs.jobId, row.jobId)).run();
      }
      tx.insert(postTargets)
        .values({
          postKey: row.postKey ?? ref.postKey,
          target: targetId,
          status: "queued",
          error: null,
          skipped: 0,
          updatedAt: now,
          rawJson: JSON.stringify({ requeued: true }),
        })
        .onConflictDoUpdate({
          target: [postTargets.postKey, postTargets.target],
          set: { status: "queued", error: null, skipped: 0, updatedAt: now, rawJson: JSON.stringify({ requeued: true }) },
        })
        .run();
      results.push({ target: targetId, outcome: existing ? "already_queued" : "requeued" });
    }
    if (ref.postId != null)
      tx.update(publications).set({ status: "scheduled", updatedAt: now }).where(eq(publications.postId, ref.postId)).run();
  });
  return {
    // Every target still in a worker's hands means nothing was requeued, and an
    // operator reading `ok: true` off `ops republish` would believe otherwise.
    ok: results.some((row) => row.outcome !== "publishing"),
    post_id: ref.postId,
    post_key: ref.postKey,
    message_id: ref.messageId,
    target: target ?? null,
    targets: results.map((row) => row.target),
    results,
  };
}

export function requeuePublicationScope(
  backendDb: BackendDb,
  ref: ResolvedPublicationRef,
  target?: string,
  locale?: "ru" | "en",
): Record<string, unknown> {
  if (target || !locale) return requeuePublication(backendDb, ref, target);
  const targets = unsafeDb(backendDb)
    .db.select({ target: postTargets.target })
    .from(postTargets)
    .where(eq(postTargets.postKey, ref.postKey))
    .all()
    .map((row) => row.target)
    .filter((value) => targetLocale(value) === locale);
  // A mutation that matched nothing is not a success. Silently returning an
  // empty result set reads as "done" to an operator running `ops republish`.
  if (targets.length === 0) throw new Error(`no ${locale} targets found for ${ref.postKey}`);
  return { ok: true, locale, results: targets.map((value) => requeuePublication(backendDb, ref, value)) };
}

export function requeueAfterRemoval(
  backendDb: BackendDb,
  ref: ResolvedPublicationRef,
  removals: Array<Record<string, unknown>>,
  target?: string,
): Record<string, unknown> {
  const succeeded = removals.filter((row) => row.ok === true && typeof row.target === "string").map((row) => row.target as string);
  // An explicitly selected target with no durable remote row is already gone;
  // it is safe to create its replacement. A failed deletion is never retried
  // as a new post, preventing accidental duplicates.
  const targets = succeeded.length > 0 ? succeeded : target ? [target] : [];
  return { ok: targets.length > 0, results: targets.map((value) => requeuePublication(backendDb, ref, value)) };
}

export async function replaceTextFallbackTargets(
  backendDb: BackendDb,
  ref: ResolvedPublicationRef,
  config: BackendConfig,
  target: string | undefined,
  locale: "ru" | "en",
  fetchImpl: typeof fetch,
): Promise<Array<Record<string, unknown>>> {
  const nativeEdit = new Set(["telegram"]);
  const targets = unsafeDb(backendDb)
    .db.select({ target: postTargets.target })
    .from(postTargets)
    .where(eq(postTargets.postKey, ref.postKey))
    .all()
    .map((row) => row.target)
    .filter((value) => (!target || value === target) && targetLocale(value) === locale && !nativeEdit.has(value));
  const results: Array<Record<string, unknown>> = [];
  for (const value of targets) {
    const removed = await removePublishedTargets(backendDb, config, { postKey: ref.postKey, target: value }, fetchImpl);
    if (removed.some((item) => item.ok)) results.push({ target: value, removed, republish: requeuePublication(backendDb, ref, value) });
  }
  return results;
}
