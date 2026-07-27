-- `admin_id` was named when Telegram was the only way into the Studio, so the
-- column read as "the Telegram user who owns this". Ownership is now resolved
-- from a credential (Telegram user id, Studio bearer token, whatever comes
-- next) to a Studio actor, and the storage should say so.
--
-- RENAME COLUMN preserves data and rewrites the indexes SQLite built on these
-- columns, so no table rebuild is needed. `idx_studio_media_assets_owner*`
-- follow their columns and keep their names.
ALTER TABLE `drafts` RENAME COLUMN `admin_id` TO `actor_id`;
--> statement-breakpoint
ALTER TABLE `pending_albums` RENAME COLUMN `admin_id` TO `actor_id`;
--> statement-breakpoint
ALTER TABLE `video_drafts` RENAME COLUMN `admin_id` TO `actor_id`;
--> statement-breakpoint
ALTER TABLE `video_bot_sessions` RENAME COLUMN `admin_id` TO `actor_id`;
--> statement-breakpoint
ALTER TABLE `studio_notification_settings` RENAME COLUMN `admin_id` TO `actor_id`;
--> statement-breakpoint
ALTER TABLE `studio_notification_jobs` RENAME COLUMN `admin_id` TO `actor_id`;
--> statement-breakpoint
ALTER TABLE `studio_media_assets` RENAME COLUMN `admin_id` TO `actor_id`;
--> statement-breakpoint
ALTER TABLE `admin_state` RENAME COLUMN `admin_id` TO `actor_id`;
--> statement-breakpoint
ALTER TABLE `bot_settings` RENAME COLUMN `admin_id` TO `actor_id`;
--> statement-breakpoint
ALTER TABLE `bot_ui_settings` RENAME COLUMN `admin_id` TO `actor_id`;
