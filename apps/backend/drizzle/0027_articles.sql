-- Long-form publications as their own content entity. Delivery is unchanged:
-- articles queue into publish_jobs and settle into publication_targets under
-- an `article:{id}` publication key, beside posts and video.
CREATE TABLE `articles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_articles_status` ON `articles` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `article_locales` (
	`article_id` integer NOT NULL,
	`locale` text NOT NULL,
	`slug` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`body_text` text,
	`entities_json` text,
	`media_json` text,
	`published_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`article_id`, `locale`)
);
