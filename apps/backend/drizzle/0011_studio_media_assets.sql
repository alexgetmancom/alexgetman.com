CREATE TABLE IF NOT EXISTS `studio_media_assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`admin_id` integer NOT NULL,
	`kind` text NOT NULL,
	`mime_type` text NOT NULL,
	`filename` text NOT NULL,
	`local_path` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_studio_media_assets_owner` ON `studio_media_assets` (`admin_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_studio_media_assets_hash` ON `studio_media_assets` (`sha256`);
