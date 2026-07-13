CREATE TABLE IF NOT EXISTS `bot_settings` (
	`admin_id` integer PRIMARY KEY NOT NULL,
	`youtube_signature` text DEFAULT '' NOT NULL,
	`pending_action` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `video_metric_schedule` (
	`video_target_id` integer PRIMARY KEY NOT NULL,
	`checkpoint_index` integer DEFAULT 0 NOT NULL,
	`next_check_at` text NOT NULL,
	`last_checked_at` text,
	`last_error` text,
	`frozen_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_video_metric_schedule_due` ON `video_metric_schedule` (`next_check_at`);
