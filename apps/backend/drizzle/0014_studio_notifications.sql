CREATE TABLE IF NOT EXISTS `studio_notification_settings` (
	`admin_id` integer PRIMARY KEY NOT NULL,
	`reminders_enabled` integer DEFAULT 1 NOT NULL,
	`reminder_minutes` integer DEFAULT 5 NOT NULL,
	`completion_enabled` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `studio_notification_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`admin_id` integer NOT NULL,
	`ref` text NOT NULL,
	`kind` text NOT NULL,
	`run_at` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_studio_notification_jobs_due` ON `studio_notification_jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_studio_notification_jobs_ref_kind` ON `studio_notification_jobs` (`ref`,`kind`);
