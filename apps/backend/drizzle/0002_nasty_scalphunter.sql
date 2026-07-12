CREATE TABLE `video_bot_sessions` (
	`admin_id` integer PRIMARY KEY NOT NULL,
	`video_draft_id` integer,
	`step` text NOT NULL,
	`selected_targets_json` text DEFAULT '[]' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `video_drafts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`admin_id` integer NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`asset_key` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`scheduled_at` text,
	`reminder_sent_at` text,
	`retention_until` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_video_drafts_status_schedule` ON `video_drafts` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE TABLE `video_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_draft_id` integer NOT NULL,
	`video_target_id` integer,
	`kind` text NOT NULL,
	`run_at` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`locked_by` text,
	`locked_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_video_jobs_due` ON `video_jobs` (`status`,`run_at`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_video_jobs_lock` ON `video_jobs` (`status`,`locked_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_video_jobs_unique` ON `video_jobs` (`video_draft_id`,`video_target_id`,`kind`);--> statement-breakpoint
CREATE TABLE `video_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_draft_id` integer NOT NULL,
	`target` text NOT NULL,
	`metadata_json` text NOT NULL,
	`scheduled_at` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`external_id` text,
	`external_url` text,
	`prepared_at` text,
	`published_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_video_targets_draft_target` ON `video_targets` (`video_draft_id`,`target`);--> statement-breakpoint
CREATE INDEX `idx_video_targets_status_schedule` ON `video_targets` (`status`,`scheduled_at`);