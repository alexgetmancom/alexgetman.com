import { eq } from "drizzle-orm";
import { targetLocale } from "../../botTargets.js";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { postTargets } from "../../db/schema.js";
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
  return unsafeDb(backendDb)
    .db.select()
    .from(postTargets)
    .where(eq(postTargets.postKey, ref.postKey))
    .all()
    .filter((row) => (!target || row.target === target) && (!locale || targetLocale(row.target) === locale))
    .map((row) => ({
      target: row.target,
      status: row.status,
      url: row.url ?? null,
      published: row.status === "published",
    }));
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
    post_key: ref.postKey,
    targets: scope,
    ...detail,
    hint: scope.length ? "re-run with apply to perform it" : "nothing is in scope; widen --target or --locale",
  };
}
