ALTER TABLE `studio_notification_settings` ADD `video_reminders_enabled` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `studio_notification_settings` ADD `post_reminders_enabled` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE `studio_notification_settings` SET `video_reminders_enabled` = `reminders_enabled`, `post_reminders_enabled` = `reminders_enabled`;--> statement-breakpoint
ALTER TABLE `studio_notification_settings` DROP COLUMN `reminders_enabled`;
