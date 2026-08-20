import { lte } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { type JsonValue, metricSamples, postMetrics } from "../../db/schema.js";

/** Persistence for collected analytics samples. */
export function upsertMetrics(
  backendDb: BackendDb,
  publicationKey: string,
  target: string,
  metrics: Record<string, number>,
  source: string,
  raw: JsonValue,
  db = unsafeDb(backendDb).db,
): void {
  const sampledAt = new Date().toISOString();
  for (const [name, value] of Object.entries(metrics)) {
    const normalized = Number.isFinite(value) ? Math.trunc(value) : 0;
    db.insert(postMetrics)
      .values({ publicationKey, target, metricName: name, value: normalized, source, sampledAt, error: null, rawJson: raw })
      .onConflictDoUpdate({
        target: [postMetrics.publicationKey, postMetrics.target, postMetrics.metricName],
        set: { value: normalized, source, sampledAt, error: null, rawJson: raw },
      })
      .run();
    db.insert(metricSamples).values({ publicationKey, target, metricName: name, value: normalized, sampledAt, source }).run();
  }
}

export function upsertMetricError(
  backendDb: BackendDb,
  publicationKey: string,
  target: string,
  source: string,
  error: string,
  raw: JsonValue,
  db = unsafeDb(backendDb).db,
): void {
  const sampledAt = new Date().toISOString();
  db.insert(postMetrics)
    .values({ publicationKey, target, metricName: "views", value: null, source, sampledAt, error, rawJson: raw })
    .onConflictDoUpdate({
      target: [postMetrics.publicationKey, postMetrics.target, postMetrics.metricName],
      set: { source, sampledAt, error, rawJson: raw },
    })
    .run();
}

// Creator reports include a 30-day period and need a checkpoint immediately
// before its start to calculate a delta.
export function pruneMetricSamples(backendDb: BackendDb, daysKeep = 35): void {
  const cutoff = new Date(Date.now() - daysKeep * 24 * 60 * 60 * 1000).toISOString();
  unsafeDb(backendDb).db.delete(metricSamples).where(lte(metricSamples.sampledAt, cutoff)).run();
}
