-- Metric-sample retention deletes purely by age (`sampled_at <= cutoff`).
-- `idx_metric_samples_lookup` starts with `post_key`, so SQLite could not use
-- it for that predicate and scanned the full append-only table on every sweep.
CREATE INDEX IF NOT EXISTS `idx_metric_samples_sampled_at` ON `metric_samples` (`sampled_at`);
