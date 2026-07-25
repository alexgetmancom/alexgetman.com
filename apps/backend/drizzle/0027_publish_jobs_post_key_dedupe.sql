-- Publish-job deduplication moves from the legacy `message_id` to `post_key`,
-- which is what every write path actually keys on. The old unique index made a
-- second post reusing one Telegram message collide on insert, failing the whole
-- publication transaction instead of one target; `message_id` stays indexed for
-- history lookups, just no longer as the uniqueness rule.
--
-- A post_key implies exactly one message_id, so the old index already ruled out
-- duplicates of the new key. The delete below is defensive only: it keeps the
-- newest job per (post_key, target, status) so this migration cannot fail at
-- boot on unexpected legacy data. Rows it would remove are exactly the
-- superseded duplicates deleteSupersededJobs already discards.
DELETE FROM `publish_jobs` WHERE `post_key` IS NOT NULL AND `job_id` NOT IN (
  SELECT MAX(`job_id`) FROM `publish_jobs` WHERE `post_key` IS NOT NULL GROUP BY `post_key`, `target`, `status`
);--> statement-breakpoint
DROP INDEX IF EXISTS `idx_publish_jobs_message_target_status`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_publish_jobs_post_target_status` ON `publish_jobs` (`post_key`,`target`,`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_publish_jobs_message` ON `publish_jobs` (`message_id`,`target`);
