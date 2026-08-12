import { eq } from "drizzle-orm";
import { targetLocale } from "../../botTargets.js";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { postTargets, publishJobs } from "../../db/schema.js";
import { removePublishedTargets } from "../../delivery/external-removals.js";
import type { BackendConfig } from "../../foundation/config.js";
import { RETRY_UNLESS_HELD, requeuePublicationTargets } from "../../publishing/requeue.js";
import { type ResolvedPublicationRef, sourcePayload } from "../publication-ref.js";

/** `ops retry` over one publication: which targets it names, and how its
 * result reads to an operator. The requeue itself belongs to Publishing, which
 * Studio's retry button also goes through — one job, one mechanism. */
function requeuePublication(backendDb: BackendDb, ref: ResolvedPublicationRef, target?: string): Record<string, unknown> {
  const scope = { postId: ref.postId, postKey: ref.postKey, messageId: ref.messageId };
  const targets = target ? [target] : jobbedTargets(backendDb, ref);
  if (targets.length === 0) throw new Error("no publish jobs found");
  const results = requeuePublicationTargets(backendDb, scope, targets, {
    from: RETRY_UNLESS_HELD,
    // An operator naming one target may be restoring a publication whose job
    // rows were never created — after a channel was connected late, or a
    // publication was planned without it.
    createMissing: Boolean(target),
    source: () => sourcePayload(backendDb, ref),
  });
  return {
    // Every target still held means nothing was requeued, and an operator
    // reading `ok: true` off `ops retry` would believe otherwise.
    ok: results.some((row) => row.outcome !== "not_retryable"),
    post_id: ref.postId,
    post_key: ref.postKey,
    message_id: ref.messageId,
    target: target ?? null,
    targets: results.map((row) => row.target),
    results,
  };
}

/** Targets this publication has ever delivered to, newest job per target. */
function jobbedTargets(backendDb: BackendDb, ref: ResolvedPublicationRef): string[] {
  const whereRef = ref.postId != null ? eq(publishJobs.postId, ref.postId) : eq(publishJobs.postKey, ref.postKey);
  return [
    ...new Set(
      unsafeDb(backendDb)
        .db.select({ target: publishJobs.target })
        .from(publishJobs)
        .where(whereRef)
        .all()
        .map((row) => row.target),
    ),
  ];
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
  // empty result set reads as "done" to an operator running `ops retry`.
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
  // it is safe to create its replacement. A deletion that was *attempted and
  // failed* is not that case, and falling back to the requested target on any
  // empty success list published a replacement next to a post still standing.
  const attempted = new Set(removals.filter((row) => row.skipped !== true).map((row) => row.target));
  const targets = target && !succeeded.includes(target) ? (attempted.has(target) ? [] : [target]) : succeeded;
  return { ok: targets.length > 0, results: targets.map((value) => requeuePublication(backendDb, ref, value)) };
}

/** Takes down and re-publishes the targets an edit could not reach in place.
 *
 * Which those are is the edit's own answer, not a second list here: a target
 * that reported `ok` was already rewritten, and deleting it afterwards produced
 * an edit, a deletion and a fresh publication of the same post. */
export async function replaceTextFallbackTargets(
  backendDb: BackendDb,
  ref: ResolvedPublicationRef,
  config: BackendConfig,
  target: string | undefined,
  locale: "ru" | "en",
  fetchImpl: typeof fetch,
  edited: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const rewritten = new Set(edited.filter((row) => row.ok === true && typeof row.target === "string").map((row) => row.target as string));
  const targets = unsafeDb(backendDb)
    .db.select({ target: postTargets.target })
    .from(postTargets)
    .where(eq(postTargets.postKey, ref.postKey))
    .all()
    .map((row) => row.target)
    .filter((value) => (!target || value === target) && targetLocale(value) === locale && !rewritten.has(value));
  const results: Array<Record<string, unknown>> = [];
  for (const value of targets) {
    const removed = await removePublishedTargets(backendDb, config, { postKey: ref.postKey, target: value }, fetchImpl);
    if (removed.some((item) => item.ok)) results.push({ target: value, removed, republish: requeuePublication(backendDb, ref, value) });
  }
  return results;
}
