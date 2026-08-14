DELETE FROM `studio_notification_jobs`
WHERE `ref` LIKE 'publication:%'
  AND EXISTS (
    SELECT 1
    FROM `studio_notification_jobs` AS `short`
    WHERE `short`.`ref` = substr(`studio_notification_jobs`.`ref`, 13)
      AND `short`.`kind` = `studio_notification_jobs`.`kind`
  );
--> statement-breakpoint
UPDATE `studio_notification_jobs`
SET `ref` = substr(`ref`, 13)
WHERE `ref` LIKE 'publication:draft:%'
   OR `ref` LIKE 'publication:post:%'
   OR `ref` LIKE 'publication:video:%';
--> statement-breakpoint
UPDATE `post_events`
SET `post_key` = substr(`post_key`, 13)
WHERE `post_key` LIKE 'publication:draft:%'
   OR `post_key` LIKE 'publication:post:%'
   OR `post_key` LIKE 'publication:video:%';
