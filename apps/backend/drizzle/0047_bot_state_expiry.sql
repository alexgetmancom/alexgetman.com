ALTER TABLE `admin_state` ADD COLUMN `expires_at` text;
--> statement-breakpoint
ALTER TABLE `video_bot_sessions` ADD COLUMN `expires_at` text;
