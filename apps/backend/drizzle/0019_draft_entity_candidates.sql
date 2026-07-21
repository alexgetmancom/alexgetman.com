CREATE TABLE `draft_entity_candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`draft_id` integer NOT NULL,
	`kind` text NOT NULL,
	`slug` text NOT NULL,
	`title_ru` text NOT NULL,
	`title_en` text,
	`status` text DEFAULT 'suggested' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_draft_entity_candidates_unique` ON `draft_entity_candidates` (`draft_id`,`kind`,`slug`);
--> statement-breakpoint
CREATE INDEX `idx_draft_entity_candidates_draft_status` ON `draft_entity_candidates` (`draft_id`,`status`);
