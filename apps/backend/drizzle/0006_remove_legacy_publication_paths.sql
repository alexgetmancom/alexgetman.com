UPDATE `post_events`
SET `post_key` = 'publication:' || `post_key`
WHERE `post_key` GLOB 'draft:[0-9]*'
   OR `post_key` GLOB 'post:[0-9]*'
   OR `post_key` GLOB 'video:[0-9]*';
--> statement-breakpoint
DELETE FROM `studio_notification_jobs`
WHERE (`ref` GLOB 'draft:[0-9]*' OR `ref` GLOB 'post:[0-9]*' OR `ref` GLOB 'video:[0-9]*')
  AND EXISTS (
    SELECT 1
    FROM `studio_notification_jobs` AS `canonical`
    WHERE `canonical`.`ref` = 'publication:' || `studio_notification_jobs`.`ref`
      AND `canonical`.`kind` = `studio_notification_jobs`.`kind`
  );
--> statement-breakpoint
UPDATE `studio_notification_jobs`
SET `ref` = 'publication:' || `ref`
WHERE `ref` GLOB 'draft:[0-9]*'
   OR `ref` GLOB 'post:[0-9]*'
   OR `ref` GLOB 'video:[0-9]*';
