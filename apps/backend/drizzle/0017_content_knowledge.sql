CREATE TABLE `post_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL,
	`url` text NOT NULL,
	`label_ru` text NOT NULL,
	`label_en` text,
	`display_kind` text,
	`published_at` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_post_sources_post_url` ON `post_sources` (`post_id`,`url`);
--> statement-breakpoint
CREATE INDEX `idx_post_sources_post_order` ON `post_sources` (`post_id`,`sort_order`);
--> statement-breakpoint
CREATE TABLE `knowledge_entities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`slug` text NOT NULL,
	`title_ru` text NOT NULL,
	`title_en` text,
	`summary_ru` text,
	`summary_en` text,
	`editorial_updated_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_knowledge_entities_kind_slug` ON `knowledge_entities` (`kind`,`slug`);
--> statement-breakpoint
CREATE INDEX `idx_knowledge_entities_kind` ON `knowledge_entities` (`kind`);
--> statement-breakpoint
CREATE TABLE `knowledge_entity_aliases` (
	`entity_id` integer NOT NULL,
	`alias` text NOT NULL,
	`normalized_alias` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`entity_id`,`alias`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_knowledge_entity_aliases_normalized` ON `knowledge_entity_aliases` (`normalized_alias`);
--> statement-breakpoint
CREATE TABLE `post_entity_links` (
	`post_id` integer NOT NULL,
	`entity_id` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`post_id`,`entity_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_post_entity_links_entity` ON `post_entity_links` (`entity_id`,`post_id`);
