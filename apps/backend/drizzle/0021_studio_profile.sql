CREATE TABLE `studio_profile` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`timezone_label` text DEFAULT 'UTC' NOT NULL,
	`site_enabled` integer DEFAULT 0 NOT NULL,
	`video_prepare_lead_minutes` integer DEFAULT 15 NOT NULL,
	`video_reminder_minutes` integer DEFAULT 5 NOT NULL,
	`video_retention_hours` integer DEFAULT 24 NOT NULL,
	`name_json` text DEFAULT '{"en":"","ru":""}' NOT NULL,
	`tagline_json` text DEFAULT '{"en":"","ru":""}' NOT NULL,
	`about_json` text DEFAULT '{"en":"","ru":""}' NOT NULL,
	`profiles_json` text DEFAULT '{"en":[],"ru":[]}' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `studio_profile` (`id`, `updated_at`) VALUES (1, '1970-01-01T00:00:00.000Z');
