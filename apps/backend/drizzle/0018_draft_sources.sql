CREATE TABLE `draft_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`draft_id` integer NOT NULL,
	`url` text NOT NULL,
	`label_ru` text NOT NULL,
	`label_en` text,
	`display_kind` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_draft_sources_draft_url` ON `draft_sources` (`draft_id`,`url`);
--> statement-breakpoint
CREATE INDEX `idx_draft_sources_draft_order` ON `draft_sources` (`draft_id`,`sort_order`);
