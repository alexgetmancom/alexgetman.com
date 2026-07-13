-- Rebuild the historical video tables with explicit cascades.  IDs are copied
-- verbatim; rows that were already orphaned are intentionally discarded.
CREATE TABLE `video_targets_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_draft_id` integer NOT NULL REFERENCES `video_drafts`(`id`) ON DELETE CASCADE,
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
INSERT INTO `video_targets_new` SELECT t.* FROM `video_targets` t WHERE EXISTS (SELECT 1 FROM `video_drafts` d WHERE d.id=t.video_draft_id);
--> statement-breakpoint
DROP TABLE `video_targets`;
--> statement-breakpoint
ALTER TABLE `video_targets_new` RENAME TO `video_targets`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_video_targets_draft_target` ON `video_targets` (`video_draft_id`,`target`);
--> statement-breakpoint
CREATE INDEX `idx_video_targets_status_schedule` ON `video_targets` (`status`,`scheduled_at`);
--> statement-breakpoint
CREATE TABLE `video_jobs_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_draft_id` integer NOT NULL REFERENCES `video_drafts`(`id`) ON DELETE CASCADE,
	`video_target_id` integer REFERENCES `video_targets`(`id`) ON DELETE CASCADE,
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
INSERT INTO `video_jobs_new`
SELECT j.* FROM `video_jobs` j
WHERE EXISTS (SELECT 1 FROM `video_drafts` d WHERE d.id=j.video_draft_id)
  AND (j.video_target_id IS NULL OR EXISTS (SELECT 1 FROM `video_targets` t WHERE t.id=j.video_target_id AND t.video_draft_id=j.video_draft_id));
--> statement-breakpoint
DROP TABLE `video_jobs`;
--> statement-breakpoint
ALTER TABLE `video_jobs_new` RENAME TO `video_jobs`;
--> statement-breakpoint
CREATE INDEX `idx_video_jobs_due` ON `video_jobs` (`status`,`run_at`,`next_attempt_at`);
--> statement-breakpoint
CREATE INDEX `idx_video_jobs_lock` ON `video_jobs` (`status`,`locked_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_video_jobs_unique` ON `video_jobs` (`video_draft_id`,`video_target_id`,`kind`);
--> statement-breakpoint
CREATE TABLE `video_metric_snapshots_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_target_id` integer NOT NULL REFERENCES `video_targets`(`id`) ON DELETE CASCADE,
	`platform` text NOT NULL,
	`metrics_json` text NOT NULL,
	`sampled_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `video_metric_snapshots_new` SELECT s.* FROM `video_metric_snapshots` s WHERE EXISTS (SELECT 1 FROM `video_targets` t WHERE t.id=s.video_target_id);
--> statement-breakpoint
DROP TABLE `video_metric_snapshots`;
--> statement-breakpoint
ALTER TABLE `video_metric_snapshots_new` RENAME TO `video_metric_snapshots`;
--> statement-breakpoint
CREATE INDEX `idx_video_metric_snapshots_target_sampled` ON `video_metric_snapshots` (`video_target_id`,`sampled_at`);
--> statement-breakpoint
CREATE TABLE `video_metric_schedule_new` (
	`video_target_id` integer PRIMARY KEY NOT NULL REFERENCES `video_targets`(`id`) ON DELETE CASCADE,
	`checkpoint_index` integer DEFAULT 0 NOT NULL,
	`next_check_at` text NOT NULL,
	`last_checked_at` text,
	`last_error` text,
	`frozen_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `video_metric_schedule_new` SELECT s.* FROM `video_metric_schedule` s WHERE EXISTS (SELECT 1 FROM `video_targets` t WHERE t.id=s.video_target_id);
--> statement-breakpoint
DROP TABLE `video_metric_schedule`;
--> statement-breakpoint
ALTER TABLE `video_metric_schedule_new` RENAME TO `video_metric_schedule`;
--> statement-breakpoint
CREATE INDEX `idx_video_metric_schedule_due` ON `video_metric_schedule` (`next_check_at`);
--> statement-breakpoint
CREATE TABLE `social_comments_new` (
	`platform` text NOT NULL,
	`comment_id` text NOT NULL,
	`video_target_id` integer NOT NULL REFERENCES `video_targets`(`id`) ON DELETE CASCADE,
	`author` text,
	`text` text NOT NULL,
	`like_count` integer DEFAULT 0 NOT NULL,
	`published_at` text,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`platform`, `comment_id`)
);
--> statement-breakpoint
INSERT INTO `social_comments_new` SELECT c.* FROM `social_comments` c WHERE EXISTS (SELECT 1 FROM `video_targets` t WHERE t.id=c.video_target_id);
--> statement-breakpoint
DROP TABLE `social_comments`;
--> statement-breakpoint
ALTER TABLE `social_comments_new` RENAME TO `social_comments`;
--> statement-breakpoint
CREATE INDEX `idx_social_comments_target` ON `social_comments` (`video_target_id`,`published_at`);
