UPDATE `conversation_sessions`
SET
  `step` = CASE `action`
    WHEN 'edit_ru' THEN 'edit_text'
    WHEN 'edit_en' THEN 'edit_text'
    WHEN 'replace_ru_media' THEN 'replace_media'
    WHEN 'replace_en_media' THEN 'replace_media'
    ELSE `step`
  END,
  `data_json` = CASE `action`
    WHEN 'edit_ru' THEN json_object('locale', 'ru')
    WHEN 'edit_en' THEN json_object('locale', 'en')
    WHEN 'replace_ru_media' THEN json_object('locale', 'ru')
    WHEN 'replace_en_media' THEN json_object('locale', 'en')
    ELSE `data_json`
  END
WHERE `kind` = 'post'
  AND `step` IS NULL
  AND `action` IN ('edit_ru', 'edit_en', 'replace_ru_media', 'replace_en_media');
--> statement-breakpoint
ALTER TABLE `conversation_sessions` DROP COLUMN `action`;
--> statement-breakpoint
ALTER TABLE `pending_albums` ADD COLUMN `step` text;
--> statement-breakpoint
ALTER TABLE `pending_albums` ADD COLUMN `step_data_json` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
UPDATE `pending_albums`
SET `step` = CASE
  WHEN `action` LIKE 'edit_text:%' THEN 'edit_text'
  WHEN `action` LIKE 'replace_media:%' THEN 'replace_media'
  WHEN `action` LIKE 'schedule_manual:%' THEN 'schedule_manual'
  WHEN `action` LIKE 'schedule_confirm:%' THEN 'schedule_confirm'
  ELSE `action`
END;
--> statement-breakpoint
UPDATE `pending_albums`
SET `step_data_json` = CASE
  WHEN `action` LIKE 'edit_text:%' THEN json_object('locale', substr(`action`, instr(`action`, ':') + 1))
  WHEN `action` LIKE 'replace_media:%' THEN json_object('locale', substr(`action`, instr(`action`, ':') + 1))
  WHEN `action` LIKE 'schedule_manual:%' THEN json_object('locale', substr(`action`, instr(`action`, ':') + 1))
  WHEN `action` LIKE 'schedule_confirm:%' THEN json_object('locale', substr(`action`, instr(`action`, ':') + 1))
  ELSE '{}'
END;
--> statement-breakpoint
ALTER TABLE `pending_albums` DROP COLUMN `action`;
