ALTER TABLE `drafts` ADD `story_publish_mode` text;
--> statement-breakpoint
CREATE TABLE `draft_story_cards` (
	`draft_id` integer NOT NULL,
	`locale` text NOT NULL,
	`source_hash` text NOT NULL,
	`headline` text NOT NULL,
	`emoji` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`local_path` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`locked_by` text,
	`locked_at` text,
	`last_error` text,
	`template_version` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`draft_id`, `locale`)
);
--> statement-breakpoint
CREATE INDEX `idx_draft_story_cards_due` ON `draft_story_cards` (`status`,`next_attempt_at`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_draft_story_cards_lock` ON `draft_story_cards` (`locked_by`,`locked_at`);
