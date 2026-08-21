import { asc, eq, or } from "drizzle-orm";
import { publicationRef } from "../application/publication-ref.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { drafts, publicationTargets } from "../db/schema.js";

/** Read-only target verification for the Operations CLI and API. */
export async function verifyPostTargets(backendDb: BackendDb, ref: string): Promise<Record<string, unknown>[]> {
  const numeric = Number(ref.replace(/^post:/, ""));
  // A non-numeric ref must not reach the query as NaN: bind it only when it is a
  // usable id, and otherwise match on the post key alone.
  const id = Number.isSafeInteger(numeric) ? numeric : null;
  const post = unsafeDb(backendDb)
    .db.select({ postId: drafts.postId })
    .from(drafts)
    .where(id == null ? eq(drafts.postId, -1) : or(eq(drafts.postId, id), eq(drafts.channelMessageId, id)))
    .get();
  if (!post?.postId) throw new Error(`post not found: ${ref}`);
  const publicationKey = publicationRef("post", post.postId);
  const targets = unsafeDb(backendDb)
    .db.select({
      target: publicationTargets.target,
      status: publicationTargets.status,
      url: publicationTargets.url,
      error: publicationTargets.error,
    })
    .from(publicationTargets)
    .where(eq(publicationTargets.publicationKey, publicationKey))
    .orderBy(asc(publicationTargets.target))
    .all();
  return Promise.all(
    targets.map(async (record) => {
      if (record.status !== "published") return { ...record, ok: false, reason: record.error ?? "not_published" };
      if (!record.url) return { ...record, ok: true, reason: "no_public_url_known" };
      try {
        const response = await fetch(record.url, {
          headers: { "user-agent": "solo-publisher-verify/1.0" },
          redirect: "follow",
          signal: AbortSignal.timeout(15_000),
        });
        // The question this answers is "is the publication still there", so a 404
        // or 410 is a failure, not a pass: a deleted post used to verify as ok.
        // 5xx stays a failure too, but as a provider fault rather than a verdict
        // about the post.
        return { ...record, ok: response.status < 400, reason: `http_${response.status}` };
      } catch (error) {
        return { ...record, ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}
