ALTER TABLE `metric_schedule` ADD COLUMN `locked_by` text;
--> statement-breakpoint
ALTER TABLE `metric_schedule` ADD COLUMN `locked_at` text;
--> statement-breakpoint
ALTER TABLE `analytics_sync` ADD COLUMN `locked_by` text;
--> statement-breakpoint
ALTER TABLE `analytics_sync` ADD COLUMN `locked_at` text;
--> statement-breakpoint
ALTER TABLE `video_metric_schedule` ADD COLUMN `locked_by` text;
--> statement-breakpoint
ALTER TABLE `video_metric_schedule` ADD COLUMN `locked_at` text;
--> statement-breakpoint
CREATE INDEX `idx_metric_schedule_lock` ON `metric_schedule` (`locked_by`,`locked_at`);
--> statement-breakpoint
CREATE INDEX `idx_video_metric_schedule_lock` ON `video_metric_schedule` (`locked_by`,`locked_at`);
