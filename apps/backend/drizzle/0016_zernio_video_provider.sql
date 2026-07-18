ALTER TABLE `video_targets` ADD COLUMN `delivery_provider` text NOT NULL DEFAULT 'native';
--> statement-breakpoint
ALTER TABLE `video_targets` ADD COLUMN `provider_account_id` text;
--> statement-breakpoint
ALTER TABLE `video_targets` ADD COLUMN `provider_post_id` text;
