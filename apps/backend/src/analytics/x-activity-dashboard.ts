import { type BackendDb, unsafeDb } from "../db/client.js";
import { zonedRollingPeriodBounds } from "../foundation/time.js";

export type XActivityDashboardItem = {
  xPostId: string;
  kind: "standalone" | "reply" | "repost";
  publishedAt: string;
  text: string;
  url: string;
  linkedPublicationKey: string | null;
  metrics: Record<string, number>;
};

export type XActivityMetricSample = {
  xPostId: string;
  metricName: string;
  value: number;
  sampledAt: string;
};

type ItemRow = Omit<XActivityDashboardItem, "kind" | "metrics"> & { kind: string };

export function xActivityDashboard(
  backendDb: BackendDb,
  weekOffset: number,
  periodDays: number,
  timeZone: string,
): XActivityDashboardItem[] {
  const [start, end] = zonedRollingPeriodBounds(weekOffset, periodDays, timeZone);
  return xActivityDashboardRange(backendDb, start, end).items;
}

/** Loads one bounded X activity history for every dashboard comparison. */
export function xActivityDashboardRange(
  backendDb: BackendDb,
  start: string,
  end: string,
): { items: XActivityDashboardItem[]; samples: XActivityMetricSample[] } {
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT x_post_id AS xPostId,kind,published_at AS publishedAt,text,url,linked_publication_key AS linkedPublicationKey
       FROM x_activity_items
       WHERE published_at BETWEEN ? AND ?
       ORDER BY published_at DESC,x_post_id DESC`,
    )
    .all(start, end) as ItemRow[];
  if (!rows.length) return { items: [], samples: [] };
  const ids = rows.map((row) => row.xPostId);
  const placeholders = ids.map(() => "?").join(",");
  const samples = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT x_post_id AS xPostId,metric_name AS metricName,value,sampled_at AS sampledAt
       FROM x_activity_metric_snapshots
       WHERE x_post_id IN (${placeholders}) AND sampled_at <= ?
       ORDER BY sampled_at ASC`,
    )
    .all(...ids, end) as XActivityMetricSample[];
  const metricsById = new Map<string, Record<string, number>>();
  for (const sample of samples) {
    const values = metricsById.get(sample.xPostId) ?? {};
    values[sample.metricName] = Number(sample.value);
    metricsById.set(sample.xPostId, values);
  }
  return {
    items: rows.map((row) => ({
      ...row,
      kind: row.kind === "reply" || row.kind === "repost" ? row.kind : "standalone",
      metrics: metricsById.get(row.xPostId) ?? {},
    })),
    samples,
  };
}
