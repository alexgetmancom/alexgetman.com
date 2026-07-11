CREATE TABLE `admin_state` (
	`admin_id` integer PRIMARY KEY NOT NULL,
	`action` text,
	`draft_id` integer,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `alert_dedup` (
	`alert_key` text PRIMARY KEY NOT NULL,
	`last_sent_at` text NOT NULL,
	`suppressed_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `analytics_rollups` (
	`rollup_key` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`subject` text NOT NULL,
	`metric_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `content_memory` (
	`post_key` text PRIMARY KEY NOT NULL,
	`message_id` integer,
	`lang` text DEFAULT 'mixed' NOT NULL,
	`title` text,
	`summary` text,
	`topics_json` text,
	`entities_json` text,
	`source_urls_json` text,
	`performance_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `credential_checks` (
	`target` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`required_env_json` text NOT NULL,
	`missing_env_json` text NOT NULL,
	`expires_at` text,
	`last_checked_at` text NOT NULL,
	`next_check_at` text,
	`last_error` text,
	`details_json` text
);
--> statement-breakpoint
CREATE TABLE `deployment_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`git_sha` text,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`backup_path` text,
	`details_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `drafts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`admin_id` integer NOT NULL,
	`status` text NOT NULL,
	`text_ru` text NOT NULL,
	`text_en_machine` text,
	`text_en_approved` text,
	`targets_json` text NOT NULL,
	`media_ru_json` text,
	`media_en_json` text,
	`channel_message_id` integer,
	`scheduled_at` text,
	`scheduled_en_at` text,
	`publish_mode` text,
	`post_id` integer,
	`text_ru_entities_json` text,
	`text_en_entities_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `likes` (
	`post_id` text NOT NULL,
	`ip_hash` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`post_id`, `ip_hash`)
);
--> statement-breakpoint
CREATE TABLE `maintenance_locks` (
	`name` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `media_assets` (
	`asset_key` text PRIMARY KEY NOT NULL,
	`post_key` text,
	`draft_id` integer,
	`locale` text DEFAULT 'ru' NOT NULL,
	`role` text DEFAULT 'original' NOT NULL,
	`media_type` text,
	`file_id` text,
	`source_path` text,
	`public_url` text,
	`sha256` text,
	`size_bytes` integer,
	`width` integer,
	`height` integer,
	`duration_seconds` real,
	`variant_of` text,
	`status` text DEFAULT 'known' NOT NULL,
	`details_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `media_test_cases` (
	`test_id` text PRIMARY KEY NOT NULL,
	`format_key` text NOT NULL,
	`title` text NOT NULL,
	`input_recipe` text NOT NULL,
	`expected_targets_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_message_id` integer,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `media_test_results` (
	`test_id` text NOT NULL,
	`target` text NOT NULL,
	`message_id` integer NOT NULL,
	`status` text NOT NULL,
	`external_id` text,
	`url` text,
	`error` text,
	`notes` text,
	`raw_json` text,
	`checked_at` text NOT NULL,
	PRIMARY KEY(`test_id`, `target`, `message_id`)
);
--> statement-breakpoint
CREATE TABLE `metric_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_key` text NOT NULL,
	`target` text NOT NULL,
	`metric_name` text DEFAULT 'views' NOT NULL,
	`value` integer,
	`sampled_at` text NOT NULL,
	`source` text,
	`raw_json` text
);
--> statement-breakpoint
CREATE INDEX `idx_metric_samples_lookup` ON `metric_samples` (`post_key`,`target`,`metric_name`,`sampled_at`);--> statement-breakpoint
CREATE TABLE `metric_schedule` (
	`post_key` text NOT NULL,
	`target` text NOT NULL,
	`next_check_at` text,
	`last_checked_at` text,
	`check_count` integer DEFAULT 0 NOT NULL,
	`frozen_at` text,
	`last_error` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`post_key`, `target`)
);
--> statement-breakpoint
CREATE TABLE `ops_actions` (
	`action_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_type` text NOT NULL,
	`action` text NOT NULL,
	`message_id` integer,
	`target` text,
	`status` text NOT NULL,
	`details_json` text,
	`created_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE TABLE `pending_albums` (
	`id` text PRIMARY KEY NOT NULL,
	`admin_id` integer NOT NULL,
	`chat_id` integer NOT NULL,
	`media_group_id` text NOT NULL,
	`action` text,
	`draft_id` integer,
	`text_ru` text DEFAULT '' NOT NULL,
	`text_entities_json` text,
	`media_json` text NOT NULL,
	`notified` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `platform_capabilities` (
	`target` text NOT NULL,
	`format_key` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`evidence_test_id` text,
	`evidence_message_id` integer,
	`evidence_url` text,
	`notes` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`target`, `format_key`)
);
--> statement-breakpoint
CREATE TABLE `platform_rules` (
	`target` text NOT NULL,
	`format_key` text NOT NULL,
	`support_status` text DEFAULT 'unknown' NOT NULL,
	`max_items` integer,
	`notes` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`target`, `format_key`)
);
--> statement-breakpoint
CREATE TABLE `post_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_key` text,
	`event_type` text DEFAULT 'ops.event' NOT NULL,
	`severity` text DEFAULT 'info' NOT NULL,
	`target` text,
	`message` text NOT NULL,
	`details_json` text,
	`created_at` text NOT NULL,
	`acked_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_post_events_lookup` ON `post_events` (`post_key`,`target`,`created_at`);--> statement-breakpoint
CREATE TABLE `post_lifecycle` (
	`post_key` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`previous_state` text,
	`entered_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`reason` text,
	`raw_json` text
);
--> statement-breakpoint
CREATE TABLE `post_locales` (
	`post_id` integer NOT NULL,
	`locale` text NOT NULL,
	`slug` text NOT NULL,
	`text` text,
	`html` text,
	`entities_json` text,
	`media_json` text,
	`site_enabled` integer DEFAULT 0 NOT NULL,
	`published_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`post_id`, `locale`)
);
--> statement-breakpoint
CREATE TABLE `post_metrics` (
	`post_key` text NOT NULL,
	`target` text NOT NULL,
	`metric_name` text DEFAULT 'views' NOT NULL,
	`value` integer,
	`unit` text DEFAULT 'count' NOT NULL,
	`source` text,
	`sampled_at` text,
	`error` text,
	`raw_json` text,
	PRIMARY KEY(`post_key`, `target`, `metric_name`)
);
--> statement-breakpoint
CREATE TABLE `post_targets` (
	`post_key` text NOT NULL,
	`target` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`external_id` text,
	`external_ids_json` text,
	`url` text,
	`error` text,
	`skipped` integer DEFAULT 0 NOT NULL,
	`published_at` text,
	`updated_at` text NOT NULL,
	`raw_json` text,
	PRIMARY KEY(`post_key`, `target`)
);
--> statement-breakpoint
CREATE TABLE `posts` (
	`post_key` text PRIMARY KEY NOT NULL,
	`post_id` integer,
	`source` text DEFAULT 'telegram' NOT NULL,
	`channel` text NOT NULL,
	`chat_id` text,
	`message_id` integer NOT NULL,
	`date_utc` text,
	`date_msk` text,
	`text` text,
	`text_en` text,
	`html` text,
	`html_en` text,
	`media_json` text,
	`media_count` integer DEFAULT 0 NOT NULL,
	`media_types_json` text,
	`site_ru_path` text,
	`site_en_path` text,
	`telegram_url` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`raw_json` text
);
--> statement-breakpoint
CREATE TABLE `publication_plans` (
	`post_id` integer PRIMARY KEY NOT NULL,
	`plan_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `publication_sources` (
	`post_id` integer PRIMARY KEY NOT NULL,
	`item_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `publications` (
	`post_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`draft_id` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`telegram_message_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `publish_jobs` (
	`job_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer,
	`post_key` text,
	`message_id` integer NOT NULL,
	`target` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`publish_at` text,
	`next_attempt_at` text,
	`locked_by` text,
	`locked_at` text,
	`payload_json` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_publish_jobs_message_target_status` ON `publish_jobs` (`message_id`,`target`,`status`);--> statement-breakpoint
CREATE INDEX `idx_publish_jobs_due` ON `publish_jobs` (`status`,`publish_at`,`next_attempt_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_publish_jobs_lock` ON `publish_jobs` (`locked_by`,`locked_at`);--> statement-breakpoint
CREATE INDEX `idx_publish_jobs_post` ON `publish_jobs` (`post_id`,`target`,`status`);--> statement-breakpoint
CREATE TABLE `publish_plans` (
	`message_id` integer PRIMARY KEY NOT NULL,
	`plan_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `site_jobs` (
	`job_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer,
	`message_id` integer NOT NULL,
	`reason` text NOT NULL,
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
CREATE INDEX `idx_site_jobs_due` ON `site_jobs` (`status`,`next_attempt_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_site_jobs_lock` ON `site_jobs` (`locked_by`,`locked_at`);--> statement-breakpoint
CREATE INDEX `idx_site_jobs_post` ON `site_jobs` (`post_id`,`status`);--> statement-breakpoint
CREATE TABLE `site_source_items` (
	`message_id` integer PRIMARY KEY NOT NULL,
	`item_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worker_state` (
	`name` text PRIMARY KEY NOT NULL,
	`state_json` text NOT NULL,
	`updated_at` text NOT NULL
);
