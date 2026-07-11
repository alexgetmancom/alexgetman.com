import { asc, eq, or } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { posts, postTargets } from "../db/schema.js";

export async function verifyPostTargets(backendDb: BackendDb, ref: string): Promise<Record<string, unknown>[]> {
  const id = Number(ref.replace(/^post:/, ""));
  const post = backendDb.db
    .select({ postKey: posts.postKey })
    .from(posts)
    .where(or(eq(posts.postKey, ref), eq(posts.postId, id), eq(posts.messageId, id)))
    .get();
  if (!post) throw new Error(`post not found: ${ref}`);
  const targets = backendDb.db
    .select({ target: postTargets.target, status: postTargets.status, url: postTargets.url, error: postTargets.error })
    .from(postTargets)
    .where(eq(postTargets.postKey, post.postKey))
    .orderBy(asc(postTargets.target))
    .all();
  return Promise.all(
    targets.map(async (record) => {
      if (record.status !== "published") return { ...record, ok: false, reason: record.error ?? "not_published" };
      if (!record.url) return { ...record, ok: true, reason: "no_public_url_known" };
      try {
        const response = await fetch(record.url, {
          headers: { "user-agent": "alexgetman-backend-verify/1.0" },
          redirect: "follow",
          signal: AbortSignal.timeout(15_000),
        });
        return { ...record, ok: response.status < 500, reason: `http_${response.status}` };
      } catch (error) {
        return { ...record, ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}
