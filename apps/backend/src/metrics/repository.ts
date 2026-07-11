import type { BackendDb } from "../db/client.js";
import { type JsonValue, metricSamples, postMetrics } from "../db/schema.js";

export function upsertMetrics(
  backendDb: BackendDb,
  postKey: string,
  target: string,
  metrics: Record<string, number>,
  source: string,
  raw: JsonValue,
): void {
  const sampledAt = new Date().toISOString();
  backendDb.sqlite.transaction(() => {
    for (const [name, value] of Object.entries(metrics)) {
      const normalized = Number.isFinite(value) ? Math.trunc(value) : 0;
      backendDb.db
        .insert(postMetrics)
        .values({ postKey, target, metricName: name, value: normalized, source, sampledAt, error: null, rawJson: raw })
        .onConflictDoUpdate({
          target: [postMetrics.postKey, postMetrics.target, postMetrics.metricName],
          set: { value: normalized, source, sampledAt, error: null, rawJson: raw },
        })
        .run();
      backendDb.db
        .insert(metricSamples)
        .values({ postKey, target, metricName: name, value: normalized, sampledAt, source, rawJson: raw })
        .run();
    }
  })();
}

export function upsertMetricError(
  backendDb: BackendDb,
  postKey: string,
  target: string,
  source: string,
  error: string,
  raw: JsonValue,
): void {
  const sampledAt = new Date().toISOString();
  backendDb.db
    .insert(postMetrics)
    .values({ postKey, target, metricName: "views", value: null, source, sampledAt, error, rawJson: raw })
    .onConflictDoUpdate({
      target: [postMetrics.postKey, postMetrics.target, postMetrics.metricName],
      set: { source, sampledAt, error, rawJson: raw },
    })
    .run();
}
