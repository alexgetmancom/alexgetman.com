CREATE INDEX `idx_video_metric_snapshots_sampled_at` ON `video_metric_snapshots` (`sampled_at`);
--> statement-breakpoint
CREATE INDEX `idx_creator_profile_snapshots_sampled_at` ON `creator_profile_snapshots` (`sampled_at`);
--> statement-breakpoint
CREATE INDEX `idx_x_activity_metric_sampled_at` ON `x_activity_metric_snapshots` (`sampled_at`);
