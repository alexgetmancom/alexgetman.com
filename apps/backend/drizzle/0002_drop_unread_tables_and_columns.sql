DROP TABLE IF EXISTS `post_lifecycle`;--> statement-breakpoint
DROP TABLE IF EXISTS `runtime_memory_samples`;--> statement-breakpoint
DROP TABLE IF EXISTS `media_test_results`;--> statement-breakpoint
DROP TABLE IF EXISTS `deployment_snapshots`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_knowledge_entity_aliases_normalized`;--> statement-breakpoint
CREATE TABLE `__new_knowledge_entity_aliases` (
	`entity_id` integer NOT NULL,
	`alias` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`entity_id`, `alias`)
);--> statement-breakpoint
INSERT INTO `__new_knowledge_entity_aliases` SELECT `entity_id`, `alias`, `created_at` FROM `knowledge_entity_aliases`;--> statement-breakpoint
DROP TABLE `knowledge_entity_aliases`;--> statement-breakpoint
ALTER TABLE `__new_knowledge_entity_aliases` RENAME TO `knowledge_entity_aliases`;--> statement-breakpoint
CREATE TABLE `__new_knowledge_entities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`slug` text NOT NULL,
	`title_ru` text NOT NULL,
	`title_en` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`parent_entity_id` integer
);--> statement-breakpoint
INSERT INTO `__new_knowledge_entities` SELECT `id`, `kind`, `slug`, `title_ru`, `title_en`, `created_at`, `updated_at`, `parent_entity_id` FROM `knowledge_entities`;--> statement-breakpoint
DROP TABLE `knowledge_entities`;--> statement-breakpoint
ALTER TABLE `__new_knowledge_entities` RENAME TO `knowledge_entities`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_knowledge_entities_kind_slug` ON `knowledge_entities` (`kind`,`slug`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_entities_kind` ON `knowledge_entities` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_entities_parent` ON `knowledge_entities` (`parent_entity_id`);
--> statement-breakpoint
CREATE TABLE `__new_posts` (
	`post_key` text PRIMARY KEY NOT NULL,
	`post_id` integer,
	`source` text DEFAULT 'telegram' NOT NULL,
	`channel` text NOT NULL,
	`chat_id` text,
	`message_id` integer NOT NULL,
	`date_utc` text,
	`date_msk` text,
	`text` text,
	`text_en` text,
	`html` text,
	`html_en` text,
	`media_json` text,
	`media_count` integer DEFAULT 0 NOT NULL,
	`site_ru_path` text,
	`site_en_path` text,
	`telegram_url` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`raw_json` text
);--> statement-breakpoint
INSERT INTO `__new_posts` SELECT `post_key`, `post_id`, `source`, `channel`, `chat_id`, `message_id`, `date_utc`, `date_msk`, `text`, `text_en`, `html`, `html_en`, `media_json`, `media_count`, `site_ru_path`, `site_en_path`, `telegram_url`, `status`, `created_at`, `updated_at`, `raw_json` FROM `posts`;--> statement-breakpoint
DROP TABLE `posts`;--> statement-breakpoint
ALTER TABLE `__new_posts` RENAME TO `posts`;
