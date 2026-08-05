DELETE FROM `conversation_sessions`;
--> statement-breakpoint
ALTER TABLE `conversation_sessions` DROP COLUMN `selected_targets_json`;
