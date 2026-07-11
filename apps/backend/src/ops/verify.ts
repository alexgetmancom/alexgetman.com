import type { BackendDb } from "../db/client.js";

export async function verifyPostTargets(backendDb: BackendDb, ref: string): Promise<Record<string, unknown>[]> {
  const id = Number(ref.replace(/^post:/, ""));
  const post = backendDb.sqlite.prepare("SELECT post_key FROM posts WHERE post_key=? OR post_id=? OR message_id=?").get(ref, id, id) as
    | { post_key: string }
    | undefined;
  if (!post) throw new Error(`post not found: ${ref}`);
  const targets = backendDb.sqlite
    .prepare("SELECT target,status,url,error FROM post_targets WHERE post_key=? ORDER BY target")
    .all(post.post_key) as Array<{ target: string; status: string; url: string | null; error: string | null }>;
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
