ALTER TABLE `studio_profile` ADD `default_targets_json` text DEFAULT '["telegram","site_ru","site_en","threads_ru","threads_en","telegram_stories","instagram_stories_ru","instagram_stories"]' NOT NULL;--> statement-breakpoint
DROP TABLE `draft_sources`;--> statement-breakpoint
DROP TABLE `post_sources`;
