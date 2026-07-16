ALTER TABLE `analytics_sync` ADD COLUMN `last_success_at` text;
--> statement-breakpoint
CREATE TABLE `creator_profile_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`platform` text NOT NULL,
	`account` text NOT NULL,
	`sampled_on` text NOT NULL,
	`metrics_json` text NOT NULL,
	`source` text NOT NULL,
	`sampled_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_creator_profile_snapshots_daily` ON `creator_profile_snapshots` (`platform`,`account`,`sampled_on`);
--> statement-breakpoint
CREATE INDEX `idx_creator_profile_snapshots_history` ON `creator_profile_snapshots` (`platform`,`account`,`sampled_at`);
--> statement-breakpoint
ALTER TABLE `video_metric_snapshots` ADD COLUMN `checkpoint_index` integer;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_video_metric_snapshots_checkpoint` ON `video_metric_snapshots` (`video_target_id`,`checkpoint_index`) WHERE `checkpoint_index` IS NOT NULL;
