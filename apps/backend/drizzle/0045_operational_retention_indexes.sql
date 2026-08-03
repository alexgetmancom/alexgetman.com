-- Retention scans delete old operator actions by creation time.
CREATE INDEX IF NOT EXISTS `idx_ops_actions_created_at` ON `ops_actions` (`created_at`);
