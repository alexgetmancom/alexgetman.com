/** Fixed metric checkpoints from the actual publication time. */
const METRIC_CHECKPOINTS_MS = [1, 4, 10, 22, 46, 94, 262, 982].map((hours) => hours * 3_600_000);

/** Fixed analytics collection checkpoints after publication. */
export function metricCheckpointAt(publishedAt: string | null, checkpointIndex: number, fallback = new Date()): Date | null {
  const offset = METRIC_CHECKPOINTS_MS[checkpointIndex];
  if (offset == null) return null;
  const published = publishedAt ? new Date(publishedAt) : fallback;
  return new Date((Number.isNaN(published.getTime()) ? fallback : published).getTime() + offset);
}
