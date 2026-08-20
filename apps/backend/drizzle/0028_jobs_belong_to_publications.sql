-- A job belongs to a publication, not to a Telegram message. `message_id` was
-- read by nothing -- no delivery adapter ever looked at it -- and it already
-- held two different things: the channel message id when a post came from the
-- channel, and the post id when it did not.
ALTER TABLE `publish_jobs` RENAME COLUMN `post_id` TO `publication_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_publish_jobs_post`;--> statement-breakpoint
CREATE INDEX `idx_publish_jobs_publication` ON `publish_jobs` (`publication_id`,`target`,`status`);--> statement-breakpoint
DROP INDEX IF EXISTS `idx_publish_jobs_message`;--> statement-breakpoint
ALTER TABLE `publish_jobs` DROP COLUMN `message_id`;
