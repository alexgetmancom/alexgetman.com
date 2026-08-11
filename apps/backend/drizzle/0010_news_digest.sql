CREATE TABLE `studio_news_digest_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`hour` integer DEFAULT 10 NOT NULL,
	`minute` integer DEFAULT 0 NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
