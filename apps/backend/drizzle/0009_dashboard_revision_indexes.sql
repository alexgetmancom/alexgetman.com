CREATE INDEX `idx_posts_updated_at` ON `posts` (`updated_at`);
CREATE INDEX `idx_post_targets_updated_at` ON `post_targets` (`updated_at`);
CREATE INDEX `idx_post_metrics_sampled_at` ON `post_metrics` (`sampled_at`);
CREATE INDEX `idx_publish_jobs_updated_at` ON `publish_jobs` (`updated_at`);
CREATE INDEX `idx_publications_created_at` ON `publications` (`created_at`);
CREATE INDEX `idx_site_jobs_updated_at` ON `site_jobs` (`updated_at`);
CREATE INDEX `idx_metric_schedule_error_updated_at` ON `metric_schedule` (`updated_at`)
  WHERE `last_error` IS NOT NULL AND `last_error` <> '';
CREATE INDEX `idx_post_events_created_at` ON `post_events` (`created_at`);
CREATE INDEX `idx_video_drafts_updated_at` ON `video_drafts` (`updated_at`);
CREATE INDEX `idx_x_activity_items_last_seen_at` ON `x_activity_items` (`last_seen_at`);
CREATE INDEX `idx_creator_profiles_updated_at` ON `creator_profiles` (`updated_at`);
CREATE INDEX `idx_credential_checks_last_checked_at` ON `credential_checks` (`last_checked_at`);
