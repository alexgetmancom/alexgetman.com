import { type BackendDb, unsafeDb } from "../db/client.js";
import { zonedRollingPeriodBounds } from "../foundation/time.js";

export type XActivityDashboardItem = {
  xPostId: string;
  kind: "standalone" | "reply" | "repost";
  publishedAt: string;
  text: string;
  url: string;
  linkedPostKey: string | null;
  metrics: Record<string, number>;
};

type ItemRow = Omit<XActivityDashboardItem, "kind" | "metrics"> & { kind: string };
type MetricRow = { xPostId: string; metricName: string; value: number };

export function xActivityDashboard(
  backendDb: BackendDb,
  weekOffset: number,
  periodDays: number,
  timeZone: string,
): XActivityDashboardItem[] {
  const [start, end] = zonedRollingPeriodBounds(weekOffset, periodDays, timeZone);
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT x_post_id AS xPostId,kind,published_at AS publishedAt,text,url,linked_post_key AS linkedPostKey
       FROM x_activity_items
       WHERE published_at BETWEEN ? AND ?
       ORDER BY published_at DESC,x_post_id DESC`,
    )
    .all(start, end) as ItemRow[];
  if (!rows.length) return [];
  const ids = rows.map((row) => row.xPostId);
  const placeholders = ids.map(() => "?").join(",");
  const metrics = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT snapshot.x_post_id AS xPostId,snapshot.metric_name AS metricName,snapshot.value
       FROM x_activity_metric_snapshots AS snapshot
       INNER JOIN (
         SELECT x_post_id,metric_name,max(sampled_at) AS sampled_at
         FROM x_activity_metric_snapshots
         WHERE x_post_id IN (${placeholders})
         GROUP BY x_post_id,metric_name
       ) AS latest
       ON latest.x_post_id=snapshot.x_post_id
         AND latest.metric_name=snapshot.metric_name
         AND latest.sampled_at=snapshot.sampled_at`,
    )
    .all(...ids) as MetricRow[];
  const metricsById = new Map<string, Record<string, number>>();
  for (const metric of metrics) {
    const values = metricsById.get(metric.xPostId) ?? {};
    values[metric.metricName] = Number(metric.value);
    metricsById.set(metric.xPostId, values);
  }
  return rows.map((row) => ({
    ...row,
    kind: row.kind === "reply" || row.kind === "repost" ? row.kind : "standalone",
    metrics: metricsById.get(row.xPostId) ?? {},
  }));
}
