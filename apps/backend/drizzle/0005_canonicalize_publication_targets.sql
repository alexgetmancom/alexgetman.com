DELETE FROM `post_targets`
WHERE `target` IN ('threads', 'twitter', 'instagram_story', 'telegram_story')
  AND EXISTS (
    SELECT 1 FROM `post_targets` canonical
    WHERE canonical.`post_key` = `post_targets`.`post_key`
      AND canonical.`target` = CASE `post_targets`.`target`
        WHEN 'threads' THEN 'threads_ru'
        WHEN 'twitter' THEN 'x'
        WHEN 'instagram_story' THEN 'instagram_stories_ru'
        WHEN 'telegram_story' THEN 'telegram_stories'
      END
  );
--> statement-breakpoint
UPDATE `post_targets` SET `target` = CASE `target`
  WHEN 'threads' THEN 'threads_ru'
  WHEN 'twitter' THEN 'x'
  WHEN 'instagram_story' THEN 'instagram_stories_ru'
  WHEN 'telegram_story' THEN 'telegram_stories'
  ELSE `target` END;
--> statement-breakpoint
DELETE FROM `post_metrics`
WHERE `target` IN ('threads', 'twitter', 'instagram_story', 'telegram_story')
  AND EXISTS (
    SELECT 1 FROM `post_metrics` canonical
    WHERE canonical.`post_key` = `post_metrics`.`post_key`
      AND canonical.`metric_name` = `post_metrics`.`metric_name`
      AND canonical.`target` = CASE `post_metrics`.`target`
        WHEN 'threads' THEN 'threads_ru'
        WHEN 'twitter' THEN 'x'
        WHEN 'instagram_story' THEN 'instagram_stories_ru'
        WHEN 'telegram_story' THEN 'telegram_stories'
      END
  );
--> statement-breakpoint
UPDATE `post_metrics` SET `target` = CASE `target`
  WHEN 'threads' THEN 'threads_ru'
  WHEN 'twitter' THEN 'x'
  WHEN 'instagram_story' THEN 'instagram_stories_ru'
  WHEN 'telegram_story' THEN 'telegram_stories'
  ELSE `target` END;
--> statement-breakpoint
DELETE FROM `metric_schedule`
WHERE `target` IN ('threads', 'twitter', 'instagram_story', 'telegram_story')
  AND EXISTS (
    SELECT 1 FROM `metric_schedule` canonical
    WHERE canonical.`post_key` = `metric_schedule`.`post_key`
      AND canonical.`target` = CASE `metric_schedule`.`target`
        WHEN 'threads' THEN 'threads_ru'
        WHEN 'twitter' THEN 'x'
        WHEN 'instagram_story' THEN 'instagram_stories_ru'
        WHEN 'telegram_story' THEN 'telegram_stories'
      END
  );
--> statement-breakpoint
UPDATE `metric_schedule` SET `target` = CASE `target`
  WHEN 'threads' THEN 'threads_ru'
  WHEN 'twitter' THEN 'x'
  WHEN 'instagram_story' THEN 'instagram_stories_ru'
  WHEN 'telegram_story' THEN 'telegram_stories'
  ELSE `target` END;
--> statement-breakpoint
UPDATE `publish_jobs`
SET `post_key` = 'post:' || `post_id`
WHERE `post_key` IS NULL AND `post_id` IS NOT NULL;
--> statement-breakpoint
DELETE FROM `publish_jobs` WHERE `post_key` IS NULL;
--> statement-breakpoint
UPDATE `publish_jobs` SET `post_id` = CAST(substr(`post_key`, 6) AS INTEGER)
WHERE `post_id` IS NULL
  AND `post_key` GLOB 'post:[0-9]*'
  AND substr(`post_key`, 6) NOT GLOB '*[^0-9]*';
--> statement-breakpoint
DELETE FROM `publish_jobs` WHERE `post_id` IS NULL;
--> statement-breakpoint
DELETE FROM `publish_jobs`
WHERE `target` IN ('threads', 'twitter', 'instagram_story', 'telegram_story')
  AND EXISTS (
    SELECT 1 FROM `publish_jobs` canonical
    WHERE canonical.`post_key` = `publish_jobs`.`post_key`
      AND canonical.`status` = `publish_jobs`.`status`
      AND canonical.`target` = CASE `publish_jobs`.`target`
        WHEN 'threads' THEN 'threads_ru'
        WHEN 'twitter' THEN 'x'
        WHEN 'instagram_story' THEN 'instagram_stories_ru'
        WHEN 'telegram_story' THEN 'telegram_stories'
      END
  );
--> statement-breakpoint
UPDATE `publish_jobs` SET
  `target` = CASE `target`
    WHEN 'threads' THEN 'threads_ru'
    WHEN 'twitter' THEN 'x'
    WHEN 'instagram_story' THEN 'instagram_stories_ru'
    WHEN 'telegram_story' THEN 'telegram_stories'
    ELSE `target` END,
  `payload_json` = replace(`payload_json`, '"telegram_story_local_path":', '"telegramStoryLocalPath":');
--> statement-breakpoint
UPDATE `metric_samples` SET `target` = CASE `target`
  WHEN 'threads' THEN 'threads_ru'
  WHEN 'twitter' THEN 'x'
  WHEN 'instagram_story' THEN 'instagram_stories_ru'
  WHEN 'telegram_story' THEN 'telegram_stories'
  ELSE `target` END;
--> statement-breakpoint
UPDATE `post_events` SET `target` = CASE `target`
  WHEN 'threads' THEN 'threads_ru'
  WHEN 'twitter' THEN 'x'
  WHEN 'instagram_story' THEN 'instagram_stories_ru'
  WHEN 'telegram_story' THEN 'telegram_stories'
  ELSE `target` END;
--> statement-breakpoint
UPDATE `ops_actions` SET `target` = CASE `target`
  WHEN 'threads' THEN 'threads_ru'
  WHEN 'twitter' THEN 'x'
  WHEN 'instagram_story' THEN 'instagram_stories_ru'
  WHEN 'telegram_story' THEN 'telegram_stories'
  ELSE `target` END;
--> statement-breakpoint
UPDATE `drafts` SET `targets_json` = replace(replace(replace(replace(
  `targets_json`, '"threads":', '"threads_ru":'), '"twitter":', '"x":'),
  '"instagram_story":', '"instagram_stories_ru":'), '"telegram_story":', '"telegram_stories":');
--> statement-breakpoint
UPDATE `publish_jobs` SET `post_id` = CASE
  WHEN `post_key` GLOB 'post:[0-9]*' AND substr(`post_key`, 6) NOT GLOB '*[^0-9]*'
  THEN CAST(substr(`post_key`, 6) AS INTEGER)
END
WHERE `post_id` IS NULL;
--> statement-breakpoint
DELETE FROM `publish_jobs` WHERE `post_id` IS NULL;
--> statement-breakpoint
CREATE TABLE `__new_publish_jobs` (
  `job_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `post_id` integer NOT NULL,
  `post_key` text NOT NULL,
  `message_id` integer NOT NULL,
  `target` text NOT NULL,
  `status` text DEFAULT 'queued' NOT NULL,
  `attempt_count` integer DEFAULT 0 NOT NULL,
  `publish_at` text,
  `next_attempt_at` text,
  `locked_by` text,
  `locked_at` text,
  `payload_json` text,
  `last_error` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `current_phase` text,
  `reconcile_attempt_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_publish_jobs` (
  `job_id`, `post_id`, `post_key`, `message_id`, `target`, `status`, `attempt_count`,
  `publish_at`, `next_attempt_at`, `locked_by`, `locked_at`, `payload_json`, `last_error`,
  `created_at`, `updated_at`, `current_phase`, `reconcile_attempt_count`
)
SELECT
  `job_id`, `post_id`, `post_key`, `message_id`, `target`, `status`, `attempt_count`,
  `publish_at`, `next_attempt_at`, `locked_by`, `locked_at`, `payload_json`, `last_error`,
  `created_at`, `updated_at`, `current_phase`, `reconcile_attempt_count`
FROM `publish_jobs`;
--> statement-breakpoint
DROP TABLE `publish_jobs`;
--> statement-breakpoint
ALTER TABLE `__new_publish_jobs` RENAME TO `publish_jobs`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_publish_jobs_post_target_status` ON `publish_jobs` (`post_key`,`target`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_publish_jobs_message` ON `publish_jobs` (`message_id`,`target`);
--> statement-breakpoint
CREATE INDEX `idx_publish_jobs_due` ON `publish_jobs` (`status`,`publish_at`,`next_attempt_at`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_publish_jobs_lock` ON `publish_jobs` (`locked_by`,`locked_at`);
--> statement-breakpoint
CREATE INDEX `idx_publish_jobs_post` ON `publish_jobs` (`post_id`,`target`,`status`);
--> statement-breakpoint
DROP TABLE IF EXISTS `channel_credentials`;
--> statement-breakpoint
UPDATE `channel_connections` SET `source` = 'registry' WHERE `source` = 'config';
--> statement-breakpoint
UPDATE `site_jobs` SET `reason` = CASE `reason`
  WHEN 'publish_ru' THEN 'site_ru'
  WHEN 'publish_en' THEN 'site_en'
  ELSE `reason` END;
--> statement-breakpoint
DELETE FROM `runtime_usage`
WHERE `feature_key` IN (
  'command_center.dashboard.payload',
  'command_center.pipeline.view',
  'command_center.post_debug.view',
  'engagement.likes.batch',
  'engagement.likes.lookup',
  'engagement.likes.toggle'
);
