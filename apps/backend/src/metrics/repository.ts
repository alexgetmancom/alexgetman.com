import type { BackendDb } from "../db/client.js";

export function upsertMetrics(
  backendDb: BackendDb,
  postKey: string,
  target: string,
  metrics: Record<string, number>,
  source: string,
  raw: unknown,
): void {
  const sampledAt = new Date().toISOString();
  const rawJson = JSON.stringify(raw);
  const upsert = backendDb.sqlite.prepare(
    `INSERT INTO post_metrics(post_key, target, metric_name, value, source, sampled_at, error, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(post_key, target, metric_name) DO UPDATE SET
       value=excluded.value, source=excluded.source, sampled_at=excluded.sampled_at, error=NULL, raw_json=excluded.raw_json`,
  );
  const sample = backendDb.sqlite.prepare(
    "INSERT INTO metric_samples(post_key, target, metric_name, value, sampled_at, source, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  backendDb.sqlite.transaction(() => {
    for (const [name, value] of Object.entries(metrics)) {
      const normalized = Number.isFinite(value) ? Math.trunc(value) : 0;
      upsert.run(postKey, target, name, normalized, source, sampledAt, rawJson);
      sample.run(postKey, target, name, normalized, sampledAt, source, rawJson);
    }
  })();
}

export function upsertMetricError(backendDb: BackendDb, postKey: string, target: string, source: string, error: string, raw: unknown): void {
  backendDb.sqlite.prepare(
    `INSERT INTO post_metrics(post_key, target, metric_name, value, source, sampled_at, error, raw_json)
     VALUES (?, ?, 'views', NULL, ?, ?, ?, ?)
     ON CONFLICT(post_key, target, metric_name) DO UPDATE SET
       source=excluded.source, sampled_at=excluded.sampled_at, error=excluded.error, raw_json=excluded.raw_json`,
  ).run(postKey, target, source, new Date().toISOString(), error, JSON.stringify(raw));
}
