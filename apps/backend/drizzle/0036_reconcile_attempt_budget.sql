ALTER TABLE `publish_jobs` ADD `reconcile_attempt_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `video_jobs` ADD `reconcile_attempt_count` integer DEFAULT 0 NOT NULL;
