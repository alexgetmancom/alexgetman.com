import { desc, inArray } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { posts, postTargets } from "../db/schema.js";

/** How many posts back the "usual" target set is learned from. Wide enough that
 * one skipped delivery cannot remove a target from the baseline, short enough
 * that a target retired months ago stops being reported as missing. */
const BASELINE_POSTS = 20;

type DeliveredTarget = { target: string; status: string; url: string | null };

type RecentPost = {
  ref: string;
  postId: number | null;
  at: string | null;
  status: string;
  headline: string;
  targets: DeliveredTarget[];
  missingTargets: string[];
};

export type RecentPublications = { expectedTargets: string[]; posts: RecentPost[] };

export type PublicationMatches = { query: string; matches: Array<Omit<RecentPost, "postId" | "status" | "missingTargets">> };

/** Recent publications with their per-target delivery state, and the targets a
 * post is missing relative to what its neighbours got. Answers "which post is
 * this, and where did it not go" — the question that otherwise takes a handful
 * of ad-hoc SQL queries against production before any repair can be scoped. */
export function recentPublications(backendDb: BackendDb, limit: number): RecentPublications {
  const rows = unsafeDb(backendDb)
    .db.select({ postKey: posts.postKey, postId: posts.postId, dateUtc: posts.dateUtc, status: posts.status, text: posts.text })
    .from(posts)
    .orderBy(desc(posts.dateUtc))
    .limit(Math.max(limit, BASELINE_POSTS))
    .all();
  const byPost = deliveredTargets(
    backendDb,
    rows.map((row) => row.postKey),
  );
  // A target counts as expected once most of the recent posts carried it, so a
  // post that legitimately went to one channel only does not drag the baseline.
  const seen = new Map<string, number>();
  for (const row of rows.slice(0, BASELINE_POSTS))
    for (const target of byPost.get(row.postKey) ?? []) seen.set(target.target, (seen.get(target.target) ?? 0) + 1);
  const quorum = Math.max(Math.ceil(Math.min(rows.length, BASELINE_POSTS) / 2), 1);
  const expectedTargets = [...seen]
    .filter(([, count]) => count >= quorum)
    .map(([target]) => target)
    .sort();
  return {
    expectedTargets,
    posts: rows.slice(0, limit).map((row) => {
      const targets = byPost.get(row.postKey) ?? [];
      const present = new Set(targets.map((target) => target.target));
      return {
        ref: row.postKey,
        postId: row.postId,
        at: row.dateUtc,
        status: row.status,
        headline: headline(row.text),
        targets,
        missingTargets: expectedTargets.filter((target) => !present.has(target)),
      };
    }),
  };
}

/** Resolves a post by a fragment of its text, so a repair can be scoped from the
 * copy at hand instead of a post id nobody memorises. */
export function findPublication(backendDb: BackendDb, query: string): PublicationMatches {
  const needle = query.trim().toLowerCase();
  if (!needle) throw new Error("--query must not be empty");
  const rows = unsafeDb(backendDb)
    .db.select({ postKey: posts.postKey, dateUtc: posts.dateUtc, text: posts.text })
    .from(posts)
    .orderBy(desc(posts.dateUtc))
    .limit(400)
    .all()
    .filter((row) => (row.text ?? "").toLowerCase().includes(needle))
    .slice(0, 10);
  const byPost = deliveredTargets(
    backendDb,
    rows.map((row) => row.postKey),
  );
  return {
    query,
    matches: rows.map((row) => ({
      ref: row.postKey,
      at: row.dateUtc,
      headline: headline(row.text),
      targets: byPost.get(row.postKey) ?? [],
    })),
  };
}

function deliveredTargets(backendDb: BackendDb, keys: string[]): Map<string, DeliveredTarget[]> {
  const byPost = new Map<string, DeliveredTarget[]>();
  if (keys.length === 0) return byPost;
  const rows = unsafeDb(backendDb)
    .db.select({ postKey: postTargets.postKey, target: postTargets.target, status: postTargets.status, url: postTargets.url })
    .from(postTargets)
    .where(inArray(postTargets.postKey, keys))
    .orderBy(postTargets.target)
    .all();
  for (const row of rows) {
    const list = byPost.get(row.postKey) ?? [];
    list.push({ target: row.target, status: row.status, url: row.url });
    byPost.set(row.postKey, list);
  }
  return byPost;
}

/** The first line is the post's own headline; anything past it is body copy the
 * operator does not need to identify the post. */
function headline(text: string | null): string {
  const first = (text ?? "").split("\n", 1)[0]?.trim() ?? "";
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

/** One line per post. The JSON form carries every target and url and runs past
 * two hundred lines for five posts, which buries the one fact being looked for:
 * which post, and what did not go out. */
export function formatRecentPublications(report: RecentPublications): string {
  return [
    `expected targets: ${report.expectedTargets.join(", ") || "none"}`,
    "",
    ...report.posts.map((post) => publicationLine(post, post.missingTargets)),
  ].join("\n");
}

export function formatPublicationMatches(report: PublicationMatches): string {
  if (report.matches.length === 0) return `no post matches ${JSON.stringify(report.query)}`;
  return report.matches.map((match) => publicationLine(match, [])).join("\n");
}

function publicationLine(
  post: { ref: string; at: string | null; headline: string; targets: DeliveredTarget[] },
  missing: string[],
): string {
  const failed = post.targets.filter((target) => target.status !== "published").map((target) => `${target.target}=${target.status}`);
  const trailer = [
    missing.length > 0 ? `MISSING ${missing.join(",")}` : "",
    failed.length > 0 ? failed.join(" ") : "",
    missing.length === 0 && failed.length === 0 ? "ok" : "",
  ]
    .filter(Boolean)
    .join("  ");
  return `${post.ref.padEnd(9)} ${(post.at ?? "").slice(0, 16).replace("T", " ")}  ${post.targets.length} targets  ${trailer}\n            ${post.headline}`;
}
