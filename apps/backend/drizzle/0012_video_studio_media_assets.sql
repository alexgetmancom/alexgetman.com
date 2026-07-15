ALTER TABLE `video_drafts` ADD COLUMN `studio_media_asset_id` integer REFERENCES `studio_media_assets`(`id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_video_drafts_studio_media_asset` ON `video_drafts` (`studio_media_asset_id`);
