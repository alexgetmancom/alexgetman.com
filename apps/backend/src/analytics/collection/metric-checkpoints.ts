/** Fixed metric checkpoints from the actual publication time. */
const POST_METRIC_CHECKPOINTS_MS = [1, 3, 6, 12, 24, 7 * 24, 30 * 24].map((hours) => hours * 3_600_000);
const VIDEO_LONG_TAIL_MS = 30 * 24 * 3_600_000;

/** Fixed analytics collection checkpoints after publication. */
export function metricCheckpointAt(publishedAt: string | null, checkpointIndex: number, fallback = new Date()): Date | null {
  const offset = POST_METRIC_CHECKPOINTS_MS[checkpointIndex];
  if (offset == null) return null;
  const published = publishedAt ? new Date(publishedAt) : fallback;
  return new Date((Number.isNaN(published.getTime()) ? fallback : published).getTime() + offset);
}

/** Video keeps the same comparable first-month checkpoints, then continues
 * one observation every 30 days while its external target still exists. */
export function videoMetricCheckpointAt(publishedAt: string | null, checkpointIndex: number, fallback = new Date()): Date {
  const published = publishedAt ? new Date(publishedAt) : fallback;
  const base = Number.isNaN(published.getTime()) ? fallback : published;
  const offset =
    POST_METRIC_CHECKPOINTS_MS[checkpointIndex] ?? VIDEO_LONG_TAIL_MS * (checkpointIndex - POST_METRIC_CHECKPOINTS_MS.length + 2);
  return new Date(base.getTime() + offset);
}
