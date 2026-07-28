ALTER TABLE `publish_jobs` ADD `current_phase` text;
--> statement-breakpoint
ALTER TABLE `post_targets` ADD `confirmation_source` text;
--> statement-breakpoint
ALTER TABLE `post_targets` ADD `verified_at` text;
--> statement-breakpoint
ALTER TABLE `video_targets` ADD `confirmation_source` text;
--> statement-breakpoint
ALTER TABLE `video_targets` ADD `verified_at` text;
