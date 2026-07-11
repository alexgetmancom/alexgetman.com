import type { BackendDb } from "../db/client.js";
import { metricSamples, postMetrics } from "../db/schema.js";

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
  backendDb.sqlite.transaction(() => {
    for (const [name, value] of Object.entries(metrics)) {
      const normalized = Number.isFinite(value) ? Math.trunc(value) : 0;
      backendDb.db
        .insert(postMetrics)
        .values({ postKey, target, metricName: name, value: normalized, source, sampledAt, error: null, rawJson })
        .onConflictDoUpdate({
          target: [postMetrics.postKey, postMetrics.target, postMetrics.metricName],
          set: { value: normalized, source, sampledAt, error: null, rawJson },
        })
        .run();
      backendDb.db.insert(metricSamples).values({ postKey, target, metricName: name, value: normalized, sampledAt, source, rawJson }).run();
    }
  })();
}

export function upsertMetricError(
  backendDb: BackendDb,
  postKey: string,
  target: string,
  source: string,
  error: string,
  raw: unknown,
): void {
  const sampledAt = new Date().toISOString();
  const rawJson = JSON.stringify(raw);
  backendDb.db
    .insert(postMetrics)
    .values({ postKey, target, metricName: "views", value: null, source, sampledAt, error, rawJson })
    .onConflictDoUpdate({
      target: [postMetrics.postKey, postMetrics.target, postMetrics.metricName],
      set: { source, sampledAt, error, rawJson },
    })
    .run();
}
