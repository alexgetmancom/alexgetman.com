ALTER TABLE `admin_state` ADD COLUMN `revision` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `video_bot_sessions` ADD COLUMN `revision` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `video_bot_sessions` ADD COLUMN `active` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `pending_albums` ADD COLUMN `state_revision` integer;
