CREATE UNIQUE INDEX IF NOT EXISTS `idx_posts_channel_message` ON `posts` (`channel`,`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_posts_post_id` ON `posts` (`post_id`) WHERE `post_id` IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_post_targets_target_external` ON `post_targets` (`target`,`external_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_post_lifecycle_state` ON `post_lifecycle` (`state`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_publications_draft` ON `publications` (`draft_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_media_assets_post` ON `media_assets` (`post_key`,`locale`,`role`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_media_assets_hash` ON `media_assets` (`sha256`);--> statement-breakpoint
DROP INDEX IF EXISTS `idx_post_events_lookup`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_post_events_lookup` ON `post_events` (`created_at`,`severity`,`target`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_post_events_post` ON `post_events` (`post_key`,`created_at`);
