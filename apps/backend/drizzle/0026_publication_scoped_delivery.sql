-- One name for the key that identifies a publication. The delivery spine
-- carries articles and video publications beside text posts, so `post_key`
-- named only the case that happened to come first.
ALTER TABLE `publish_jobs` RENAME COLUMN `post_key` TO `publication_key`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_publish_jobs_post_target_status`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_publish_jobs_publication_target_status` ON `publish_jobs` (`publication_key`,`target`,`status`);--> statement-breakpoint
ALTER TABLE `post_targets` RENAME TO `publication_targets`;--> statement-breakpoint
ALTER TABLE `publication_targets` RENAME COLUMN `post_key` TO `publication_key`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_post_targets_updated_at`;--> statement-breakpoint
CREATE INDEX `idx_publication_targets_updated_at` ON `publication_targets` (`updated_at`);--> statement-breakpoint
ALTER TABLE `post_events` RENAME TO `publication_events`;--> statement-breakpoint
ALTER TABLE `publication_events` RENAME COLUMN `post_key` TO `publication_key`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_post_events_lookup`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_post_events_created_at`;--> statement-breakpoint
CREATE INDEX `idx_publication_events_lookup` ON `publication_events` (`publication_key`,`target`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_publication_events_created_at` ON `publication_events` (`created_at`);--> statement-breakpoint
ALTER TABLE `posts` RENAME COLUMN `post_key` TO `publication_key`;--> statement-breakpoint
ALTER TABLE `post_metrics` RENAME COLUMN `post_key` TO `publication_key`;--> statement-breakpoint
ALTER TABLE `metric_samples` RENAME COLUMN `post_key` TO `publication_key`;--> statement-breakpoint
ALTER TABLE `metric_schedule` RENAME COLUMN `post_key` TO `publication_key`;--> statement-breakpoint
ALTER TABLE `x_activity_items` RENAME COLUMN `linked_post_key` TO `linked_publication_key`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_metric_samples_lookup`;--> statement-breakpoint
CREATE INDEX `idx_metric_samples_lookup` ON `metric_samples` (`publication_key`,`target`,`metric_name`,`sampled_at`);--> statement-breakpoint
DROP INDEX IF EXISTS `idx_x_activity_items_linked_post`;--> statement-breakpoint
CREATE INDEX `idx_x_activity_items_linked_post` ON `x_activity_items` (`linked_publication_key`);
