CREATE TABLE `__keep_video_targets` AS SELECT target.* FROM `video_targets` AS target INNER JOIN `video_drafts` AS draft ON draft.id = target.video_draft_id WHERE draft.studio_media_asset_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__keep_video_jobs` AS SELECT job.* FROM `video_jobs` AS job INNER JOIN `video_drafts` AS draft ON draft.id = job.video_draft_id WHERE draft.studio_media_asset_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__keep_video_metric_snapshots` AS SELECT snapshot.* FROM `video_metric_snapshots` AS snapshot INNER JOIN `video_targets` AS target ON target.id = snapshot.video_target_id INNER JOIN `video_drafts` AS draft ON draft.id = target.video_draft_id WHERE draft.studio_media_asset_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__keep_video_metric_schedule` AS SELECT schedule.* FROM `video_metric_schedule` AS schedule INNER JOIN `video_targets` AS target ON target.id = schedule.video_target_id INNER JOIN `video_drafts` AS draft ON draft.id = target.video_draft_id WHERE draft.studio_media_asset_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__keep_social_comments` AS SELECT comment.* FROM `social_comments` AS comment INNER JOIN `video_targets` AS target ON target.id = comment.video_target_id INNER JOIN `video_drafts` AS draft ON draft.id = target.video_draft_id WHERE draft.studio_media_asset_id IS NOT NULL;--> statement-breakpoint
DROP TABLE `social_comments`;--> statement-breakpoint
DROP TABLE `video_metric_schedule`;--> statement-breakpoint
DROP TABLE `video_metric_snapshots`;--> statement-breakpoint
DROP TABLE `video_jobs`;--> statement-breakpoint
DROP TABLE `video_targets`;--> statement-breakpoint
DELETE FROM `video_drafts` WHERE `studio_media_asset_id` IS NULL;--> statement-breakpoint
CREATE TABLE `__new_video_drafts` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `actor_id` integer NOT NULL,
  `locale` text DEFAULT 'ru' NOT NULL,
  `label` text DEFAULT '' NOT NULL,
  `studio_media_asset_id` integer NOT NULL REFERENCES `studio_media_assets`(`id`),
  `status` text DEFAULT 'draft' NOT NULL,
  `scheduled_at` text,
  `reminder_sent_at` text,
  `retention_until` text,
  `source_pruned_at` text,
  `control_chat_id` integer,
  `control_message_id` integer,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_video_drafts` SELECT `id`, `actor_id`, `locale`, `label`, `studio_media_asset_id`, `status`, `scheduled_at`, `reminder_sent_at`, `retention_until`, `source_pruned_at`, `control_chat_id`, `control_message_id`, `created_at`, `updated_at` FROM `video_drafts`;--> statement-breakpoint
DROP TABLE `video_drafts`;--> statement-breakpoint
ALTER TABLE `__new_video_drafts` RENAME TO `video_drafts`;--> statement-breakpoint
CREATE TABLE `video_targets` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `video_draft_id` integer NOT NULL REFERENCES `video_drafts`(`id`) ON DELETE CASCADE,
  `target` text NOT NULL,
  `metadata_json` text NOT NULL,
  `scheduled_at` text,
  `status` text DEFAULT 'draft' NOT NULL,
  `delivery_provider` text DEFAULT 'native' NOT NULL,
  `provider_account_id` text,
  `provider_post_id` text,
  `external_id` text,
  `external_url` text,
  `prepared_at` text,
  `published_at` text,
  `confirmation_source` text,
  `verified_at` text,
  `last_error` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);--> statement-breakpoint
INSERT INTO `video_targets` (`id`,`video_draft_id`,`target`,`metadata_json`,`scheduled_at`,`status`,`delivery_provider`,`provider_account_id`,`provider_post_id`,`external_id`,`external_url`,`prepared_at`,`published_at`,`confirmation_source`,`verified_at`,`last_error`,`created_at`,`updated_at`) SELECT `id`,`video_draft_id`,`target`,`metadata_json`,`scheduled_at`,`status`,`delivery_provider`,`provider_account_id`,`provider_post_id`,`external_id`,`external_url`,`prepared_at`,`published_at`,`confirmation_source`,`verified_at`,`last_error`,`created_at`,`updated_at` FROM `__keep_video_targets`;--> statement-breakpoint
DROP TABLE `__keep_video_targets`;--> statement-breakpoint
CREATE TABLE `video_jobs` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `video_draft_id` integer NOT NULL REFERENCES `video_drafts`(`id`) ON DELETE CASCADE,
  `video_target_id` integer REFERENCES `video_targets`(`id`) ON DELETE CASCADE,
  `kind` text NOT NULL,
  `run_at` text NOT NULL,
  `status` text DEFAULT 'queued' NOT NULL,
  `reconcile_attempt_count` integer DEFAULT 0 NOT NULL,
  `attempt_count` integer DEFAULT 0 NOT NULL,
  `next_attempt_at` text,
  `locked_by` text,
  `locked_at` text,
  `last_error` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);--> statement-breakpoint
INSERT INTO `video_jobs` (`id`,`video_draft_id`,`video_target_id`,`kind`,`run_at`,`status`,`reconcile_attempt_count`,`attempt_count`,`next_attempt_at`,`locked_by`,`locked_at`,`last_error`,`created_at`,`updated_at`) SELECT `id`,`video_draft_id`,`video_target_id`,`kind`,`run_at`,`status`,`reconcile_attempt_count`,`attempt_count`,`next_attempt_at`,`locked_by`,`locked_at`,`last_error`,`created_at`,`updated_at` FROM `__keep_video_jobs`;--> statement-breakpoint
DROP TABLE `__keep_video_jobs`;--> statement-breakpoint
CREATE TABLE `video_metric_snapshots` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `video_target_id` integer NOT NULL REFERENCES `video_targets`(`id`) ON DELETE CASCADE, `platform` text NOT NULL, `metrics_json` text NOT NULL, `checkpoint_index` integer, `sampled_at` text NOT NULL);--> statement-breakpoint
INSERT INTO `video_metric_snapshots` (`id`,`video_target_id`,`platform`,`metrics_json`,`checkpoint_index`,`sampled_at`) SELECT `id`,`video_target_id`,`platform`,`metrics_json`,`checkpoint_index`,`sampled_at` FROM `__keep_video_metric_snapshots`;--> statement-breakpoint
DROP TABLE `__keep_video_metric_snapshots`;--> statement-breakpoint
CREATE TABLE `video_metric_schedule` (`video_target_id` integer PRIMARY KEY NOT NULL REFERENCES `video_targets`(`id`) ON DELETE CASCADE, `checkpoint_index` integer DEFAULT 0 NOT NULL, `next_check_at` text NOT NULL, `last_checked_at` text, `last_error` text, `error_count` integer DEFAULT 0 NOT NULL, `frozen_at` text, `locked_by` text, `locked_at` text, `updated_at` text NOT NULL);--> statement-breakpoint
INSERT INTO `video_metric_schedule` (`video_target_id`,`checkpoint_index`,`next_check_at`,`last_checked_at`,`last_error`,`error_count`,`frozen_at`,`locked_by`,`locked_at`,`updated_at`) SELECT `video_target_id`,`checkpoint_index`,`next_check_at`,`last_checked_at`,`last_error`,`error_count`,`frozen_at`,`locked_by`,`locked_at`,`updated_at` FROM `__keep_video_metric_schedule`;--> statement-breakpoint
DROP TABLE `__keep_video_metric_schedule`;--> statement-breakpoint
CREATE TABLE `social_comments` (`platform` text NOT NULL, `comment_id` text NOT NULL, `video_target_id` integer NOT NULL REFERENCES `video_targets`(`id`) ON DELETE CASCADE, `author` text, `text` text NOT NULL, `like_count` integer DEFAULT 0 NOT NULL, `published_at` text, `fetched_at` text NOT NULL, PRIMARY KEY(`platform`, `comment_id`));--> statement-breakpoint
INSERT INTO `social_comments` SELECT * FROM `__keep_social_comments`;--> statement-breakpoint
DROP TABLE `__keep_social_comments`;--> statement-breakpoint
CREATE INDEX `idx_video_drafts_status_schedule` ON `video_drafts` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `idx_video_drafts_studio_media_asset` ON `video_drafts` (`studio_media_asset_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_video_targets_draft_target` ON `video_targets` (`video_draft_id`,`target`);--> statement-breakpoint
CREATE INDEX `idx_video_targets_status_schedule` ON `video_targets` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `idx_video_jobs_due` ON `video_jobs` (`status`,`run_at`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_video_jobs_lock` ON `video_jobs` (`status`,`locked_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_video_jobs_unique` ON `video_jobs` (`video_draft_id`,`video_target_id`,`kind`);--> statement-breakpoint
CREATE INDEX `idx_video_metric_snapshots_target_sampled` ON `video_metric_snapshots` (`video_target_id`,`sampled_at`);--> statement-breakpoint
CREATE INDEX `idx_video_metric_snapshots_sampled_at` ON `video_metric_snapshots` (`sampled_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_video_metric_snapshots_checkpoint` ON `video_metric_snapshots` (`video_target_id`,`checkpoint_index`) WHERE `checkpoint_index` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_video_metric_schedule_lock` ON `video_metric_schedule` (`locked_by`,`locked_at`);--> statement-breakpoint
CREATE INDEX `idx_social_comments_target` ON `social_comments` (`video_target_id`,`published_at`);--> statement-breakpoint
DELETE FROM `worker_state` WHERE `name` IN ('crosspost_worker', 'telegram_to_threads', 'telegram_business_connection');
