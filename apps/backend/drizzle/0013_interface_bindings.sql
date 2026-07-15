CREATE TABLE IF NOT EXISTS `interface_bindings` (
  `interface_id` text NOT NULL,
  `entity_type` text NOT NULL,
  `entity_id` integer NOT NULL,
  `conversation_id` text NOT NULL,
  `message_id` text NOT NULL,
  `state_json` text NOT NULL DEFAULT '{}',
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`interface_id`, `entity_type`, `entity_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_interface_bindings_lookup` ON `interface_bindings` (`entity_type`, `entity_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `interface_bindings` (`interface_id`, `entity_type`, `entity_id`, `conversation_id`, `message_id`, `created_at`, `updated_at`)
SELECT 'telegram', 'draft', `draft_id`, CAST(`chat_id` AS TEXT), CAST(`message_id` AS TEXT), `updated_at`, `updated_at`
FROM `post_control_cards`;
--> statement-breakpoint
INSERT OR IGNORE INTO `interface_bindings` (`interface_id`, `entity_type`, `entity_id`, `conversation_id`, `message_id`, `created_at`, `updated_at`)
SELECT 'telegram', 'video_draft', `id`, CAST(`control_chat_id` AS TEXT), CAST(`control_message_id` AS TEXT), `updated_at`, `updated_at`
FROM `video_drafts`
WHERE `control_chat_id` IS NOT NULL AND `control_message_id` IS NOT NULL;
