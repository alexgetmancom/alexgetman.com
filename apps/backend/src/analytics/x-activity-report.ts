import { type BackendDb, unsafeDb } from "../db/client.js";
import { bestSimilarMatch, editorialTexts } from "./x-post-matching.js";

/** How alike an unlinked item and an editorial post must read before a human is
 * asked to look. Below what the linker acts on, so this list is exactly what it
 * refused: the same texts on different days, and the near-misses. */
const CANDIDATE_SIMILARITY = 0.5;

export type XAnalyticsReport = {
  imports: Array<{
    id: number;
    sourceFile: string;
    periodStart: string | null;
    periodEnd: string | null;
    sampledAt: string;
    importedAt: string;
    rowCount: number;
    items: number;
    snapshots: number;
  }>;
  items: {
    total: number;
    linked: number;
    unlinked: number;
    byKind: Record<string, number>;
    publishedRange: { first: string | null; last: string | null };
  };
  snapshots: { total: number; sampledAt: string[] };
  editorialCoverage: {
    xTargets: number;
    covered: number;
    uncovered: Array<{ postKey: string; externalId: string | null }>;
  };
  linkCandidates: Array<{
    xPostId: string;
    postKey: string;
    similarity: number;
    sameDay: boolean;
    url: string;
    text: string;
    postText: string;
  }>;
  topUnlinked: Array<{
    xPostId: string;
    kind: string;
    publishedAt: string | null;
    url: string;
    text: string;
    metrics: Record<string, number>;
  }>;
};

/** Read-only account of what the X CSV imports have accumulated: what came in,
 * what is attached to an editorial post, and what an import declined to link. */
export function xAnalyticsReport(backendDb: BackendDb, limit: number): XAnalyticsReport {
  const sqlite = unsafeDb(backendDb).sqlite;
  const query = <T>(sql: string, ...args: unknown[]): T[] => sqlite.prepare(sql).all(...args) as T[];

  const imports = query<{
    id: number;
    sourceFile: string;
    periodStart: string | null;
    periodEnd: string | null;
    sampledAt: string;
    importedAt: string;
    rowCount: number;
    snapshots: number;
  }>(
    `SELECT imports.id, imports.source_file AS sourceFile, imports.period_start AS periodStart, imports.period_end AS periodEnd,
            imports.sampled_at AS sampledAt, imports.imported_at AS importedAt, imports.row_count AS rowCount,
            count(snapshot.id) AS snapshots
     FROM x_activity_imports AS imports
     LEFT JOIN x_activity_metric_snapshots AS snapshot ON snapshot.import_id=imports.id
     GROUP BY imports.id
     ORDER BY imports.id`,
  ).map((row) => ({
    ...row,
    items:
      query<{ count: number }>("SELECT count(DISTINCT x_post_id) AS count FROM x_activity_metric_snapshots WHERE import_id=?", row.id)[0]
        ?.count ?? 0,
  }));

  const totals = query<{ total: number; linked: number; first: string | null; last: string | null }>(
    `SELECT count(*) AS total,
            sum(CASE WHEN linked_post_key IS NOT NULL THEN 1 ELSE 0 END) AS linked,
            min(published_at) AS first, max(published_at) AS last
     FROM x_activity_items`,
  )[0] ?? { total: 0, linked: 0, first: null, last: null };
  const byKind = Object.fromEntries(
    query<{ kind: string; count: number }>("SELECT kind, count(*) AS count FROM x_activity_items GROUP BY kind ORDER BY count DESC").map(
      (row) => [row.kind, row.count],
    ),
  );

  const snapshotTotal = query<{ count: number }>("SELECT count(*) AS count FROM x_activity_metric_snapshots")[0]?.count ?? 0;
  const sampledAt = query<{ sampledAt: string }>(
    "SELECT DISTINCT sampled_at AS sampledAt FROM x_activity_metric_snapshots ORDER BY sampled_at",
  ).map((row) => row.sampledAt);

  const xTargets = query<{ postKey: string; externalId: string | null; covered: number }>(
    `SELECT target.post_key AS postKey, target.external_id AS externalId,
            (SELECT count(*) FROM x_activity_items AS item WHERE item.linked_post_key=target.post_key) AS covered
     FROM post_targets AS target
     WHERE target.target='x' AND target.status='published'`,
  );

  const unlinked = query<{ xPostId: string; kind: string; publishedAt: string | null; text: string; url: string }>(
    `SELECT x_post_id AS xPostId, kind, published_at AS publishedAt, text, url
     FROM x_activity_items WHERE linked_post_key IS NULL`,
  );
  const editorial = editorialTexts(backendDb);
  const linkCandidates = unlinked.flatMap((item) => {
    if (item.kind !== "standalone") return [];
    const best = bestSimilarMatch(item.text, editorial);
    if (!best || best.similarity < CANDIDATE_SIMILARITY) return [];
    return [
      {
        xPostId: item.xPostId,
        postKey: best.postKey,
        similarity: Math.round(best.similarity * 100) / 100,
        sameDay: best.date?.slice(0, 10) === item.publishedAt?.slice(0, 10),
        url: item.url,
        text: item.text.slice(0, 120),
        postText: best.text.slice(0, 120),
      },
    ];
  });

  // The newest snapshot of every metric, so an item is reported exactly as X
  // last described it — the same numbers the export screen shows.
  const latest = query<{ xPostId: string; metricName: string; value: number }>(
    `SELECT snapshot.x_post_id AS xPostId, snapshot.metric_name AS metricName, snapshot.value
     FROM x_activity_metric_snapshots AS snapshot
     INNER JOIN (
       SELECT x_post_id, metric_name, max(sampled_at) AS sampled_at
       FROM x_activity_metric_snapshots GROUP BY x_post_id, metric_name
     ) AS newest
       ON newest.x_post_id=snapshot.x_post_id AND newest.metric_name=snapshot.metric_name
         AND newest.sampled_at=snapshot.sampled_at`,
  );
  const metricsById = new Map<string, Record<string, number>>();
  for (const row of latest) {
    const values = metricsById.get(row.xPostId) ?? {};
    values[row.metricName] = Number(row.value);
    metricsById.set(row.xPostId, values);
  }
  const topUnlinked = unlinked
    .map((item) => ({ ...item, text: item.text.slice(0, 120), metrics: metricsById.get(item.xPostId) ?? {} }))
    .sort((left, right) => (right.metrics.views ?? 0) - (left.metrics.views ?? 0))
    .slice(0, limit);

  return {
    imports,
    items: {
      total: totals.total,
      linked: Number(totals.linked ?? 0),
      unlinked: totals.total - Number(totals.linked ?? 0),
      byKind,
      publishedRange: { first: totals.first, last: totals.last },
    },
    snapshots: { total: snapshotTotal, sampledAt },
    editorialCoverage: {
      xTargets: xTargets.length,
      covered: xTargets.filter((target) => target.covered > 0).length,
      uncovered: xTargets.filter((target) => target.covered === 0).map(({ postKey, externalId }) => ({ postKey, externalId })),
    },
    linkCandidates: linkCandidates.sort((left, right) => right.similarity - left.similarity),
    topUnlinked,
  };
}
