CREATE TABLE `studio_weekly_digest_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`weekday` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
