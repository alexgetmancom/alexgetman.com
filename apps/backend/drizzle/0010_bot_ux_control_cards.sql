CREATE TABLE IF NOT EXISTS `bot_ui_settings` (
	`admin_id` integer PRIMARY KEY NOT NULL,
	`locale` text NOT NULL DEFAULT 'en',
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `post_control_cards` (
	`draft_id` integer PRIMARY KEY NOT NULL,
	`chat_id` integer NOT NULL,
	`message_id` integer NOT NULL,
	`updated_at` text NOT NULL
);
