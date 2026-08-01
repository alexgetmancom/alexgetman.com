CREATE TABLE `runtime_usage` (
	`feature_key` text NOT NULL,
	`bucket_day` text NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`successes` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`total_duration_ms` integer DEFAULT 0 NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	PRIMARY KEY(`feature_key`, `bucket_day`)
);
--> statement-breakpoint
CREATE INDEX `idx_runtime_usage_bucket_day` ON `runtime_usage` (`bucket_day`);
--> statement-breakpoint
CREATE INDEX `idx_runtime_usage_feature_last_seen` ON `runtime_usage` (`feature_key`, `last_seen_at`);
