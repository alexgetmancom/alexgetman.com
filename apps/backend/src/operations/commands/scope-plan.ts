import { eq } from "drizzle-orm";
import { targetLocale } from "../../botTargets.js";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { publicationTargets, publishJobs } from "../../db/schema.js";
import type { ResolvedPublicationRef } from "../publication-ref.js";

type ScopedTarget = { target: string; status: string; url: string | null; published: boolean };

/** What a command scoped by `--target` / `--locale` would actually reach.
 *
 * Every command that takes a post down and puts it back reports this before it
 * runs, because the scope is the part an operator gets wrong: a missing
 * `--target` on `delete` is the difference between one Threads post and every
 * English surface at once, and by the time the result comes back the audience
 * has already seen it. */
export function publicationScope(backendDb: BackendDb, ref: ResolvedPublicationRef, target?: string, locale?: "ru" | "en"): ScopedTarget[] {
  const db = unsafeDb(backendDb).db;
  const scoped = (value: string): boolean => (!target || value === target) && (!locale || targetLocale(value) === locale);
  const rows = new Map<string, ScopedTarget>();
  // A target with a job but no delivery row yet is still in scope: `retry` works
  // off the jobs, and reading only `publication_targets` here reported "nothing is in
  // scope" for a publication whose targets `--apply` then went and requeued.
  for (const row of db.select({ target: publishJobs.target, status: publishJobs.status }).from(publishJobs).where(jobsOf(ref)).all())
    if (scoped(row.target)) rows.set(row.target, { target: row.target, status: row.status, url: null, published: false });
  for (const row of db.select().from(publicationTargets).where(eq(publicationTargets.publicationKey, ref.publicationKey)).all())
    if (scoped(row.target))
      rows.set(row.target, { target: row.target, status: row.status, url: row.url ?? null, published: row.status === "published" });
  return [...rows.values()].sort((left, right) => left.target.localeCompare(right.target));
}

/** The publication's own jobs, by whichever identity it has. */
function jobsOf(ref: ResolvedPublicationRef) {
  return ref.postId != null ? eq(publishJobs.publicationId, ref.postId) : eq(publishJobs.publicationKey, ref.publicationKey);
}

export function scopePlan(
  action: string,
  ref: ResolvedPublicationRef,
  scope: ScopedTarget[],
  detail: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ok: true,
    applied: false,
    action,
    post_id: ref.postId,
    publication_key: ref.publicationKey,
    targets: scope,
    ...detail,
    hint: scope.length ? "re-run with apply to perform it" : "nothing is in scope; widen --target or --locale",
  };
}
