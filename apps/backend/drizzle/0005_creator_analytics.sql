CREATE TABLE `analytics_sync` (
	`source` text PRIMARY KEY NOT NULL,
	`last_synced_at` text NOT NULL,
	`last_error` text
);
--> statement-breakpoint
CREATE TABLE `creator_profiles` (
	`platform` text PRIMARY KEY NOT NULL,
	`data_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `video_metric_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_target_id` integer NOT NULL,
	`platform` text NOT NULL,
	`metrics_json` text NOT NULL,
	`sampled_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_video_metric_snapshots_target_sampled` ON `video_metric_snapshots` (`video_target_id`,`sampled_at`);
--> statement-breakpoint
CREATE TABLE `social_comments` (
	`platform` text NOT NULL,
	`comment_id` text NOT NULL,
	`video_target_id` integer NOT NULL,
	`author` text,
	`text` text NOT NULL,
	`like_count` integer DEFAULT 0 NOT NULL,
	`published_at` text,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`platform`, `comment_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_social_comments_target` ON `social_comments` (`video_target_id`,`published_at`);
