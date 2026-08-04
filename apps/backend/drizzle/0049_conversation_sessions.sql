CREATE TABLE `conversation_sessions` (
	`actor_id` integer NOT NULL,
	`kind` text NOT NULL,
	`draft_id` integer,
	`action` text,
	`step` text,
	`selected_targets_json` text DEFAULT '[]' NOT NULL,
	`data_json` text DEFAULT '{}' NOT NULL,
	`control_message_id` integer,
	`revision` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	`expires_at` text,
	PRIMARY KEY(`actor_id`, `kind`)
);
--> statement-breakpoint
CREATE INDEX `idx_conversation_sessions_expiry` ON `conversation_sessions` (`active`,`expires_at`);
--> statement-breakpoint
INSERT INTO `conversation_sessions` (`actor_id`, `kind`, `draft_id`, `action`, `step`, `selected_targets_json`, `data_json`, `control_message_id`, `revision`, `active`, `updated_at`, `expires_at`)
SELECT `actor_id`, 'post', `draft_id`, `action`, NULL, '[]', '{}', `control_message_id`, `revision`, CASE WHEN `action` IS NULL THEN 0 ELSE 1 END, `updated_at`, `expires_at`
FROM `admin_state`;
--> statement-breakpoint
INSERT INTO `conversation_sessions` (`actor_id`, `kind`, `draft_id`, `action`, `step`, `selected_targets_json`, `data_json`, `control_message_id`, `revision`, `active`, `updated_at`, `expires_at`)
SELECT `actor_id`, 'video', `video_draft_id`, NULL, `step`, `selected_targets_json`, `data_json`, NULL, `revision`, `active`, `updated_at`, `expires_at`
FROM `video_bot_sessions`;
--> statement-breakpoint
DROP TABLE `admin_state`;
--> statement-breakpoint
DROP TABLE `video_bot_sessions`;
