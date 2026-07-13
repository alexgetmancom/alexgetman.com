CREATE TABLE `site_pageviews` (
	`day` text NOT NULL,
	`path` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`day`, `path`)
);
--> statement-breakpoint
CREATE INDEX `idx_site_pageviews_day` ON `site_pageviews` (`day`);
