-- Album finalization used to retry forever: a failure reset `notified` back to
-- SETTLED with a fresh `updated_at`, so a deterministic error (an expired
-- Telegram file_id, say) re-ran once per settle window until the end of time,
-- with nothing visible to the sender. `attempt_count` bounds that and lets the
-- worker give up loudly.
--
-- Recreated rather than ALTERed: SQLite has no `ADD COLUMN IF NOT EXISTS`, and
-- migrations here must survive being replayed over an already-migrated database
-- (see baselineDrizzleMigrations). `pending_albums` holds only in-flight albums
-- that settle within seconds, and a migration runs at boot with no worker
-- consuming them, so dropping the table costs nothing a restart wouldn't.
DROP TABLE IF EXISTS `pending_albums`;--> statement-breakpoint
CREATE TABLE `pending_albums` (
	`id` text PRIMARY KEY NOT NULL,
	`admin_id` integer NOT NULL,
	`chat_id` integer NOT NULL,
	`media_group_id` text NOT NULL,
	`action` text,
	`draft_id` integer,
	`text_ru` text DEFAULT '' NOT NULL,
	`text_entities_json` text,
	`media_json` text NOT NULL,
	`notified` integer DEFAULT 0 NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);--> statement-breakpoint
-- Studio media is content-addressed per owner: importStudioMediaFile looks for
-- an existing (admin_id, sha256) row before inserting. Without a unique index
-- two concurrent uploads of one file both miss the lookup and insert twins.
-- Dedupe first — keeping the oldest row, whose local_path is the one already
-- referenced by any draft — so the index can be created on legacy data.
DELETE FROM `studio_media_assets` WHERE `id` NOT IN (
  SELECT MIN(`id`) FROM `studio_media_assets` GROUP BY `admin_id`, `sha256`
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_studio_media_assets_owner_hash` ON `studio_media_assets` (`admin_id`,`sha256`);
