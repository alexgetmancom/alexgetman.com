CREATE TABLE `x_activity_imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`checksum` text NOT NULL,
	`source_file` text NOT NULL,
	`period_start` text,
	`period_end` text,
	`sampled_at` text NOT NULL,
	`imported_at` text NOT NULL,
	`row_count` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_x_activity_imports_checksum` ON `x_activity_imports` (`checksum`);
--> statement-breakpoint
CREATE TABLE `x_activity_items` (
	`x_post_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`published_at` text,
	`text` text NOT NULL,
	`url` text NOT NULL,
	`linked_post_key` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`raw_json` text
);
--> statement-breakpoint
CREATE INDEX `idx_x_activity_items_published` ON `x_activity_items` (`published_at`);
--> statement-breakpoint
CREATE INDEX `idx_x_activity_items_linked_post` ON `x_activity_items` (`linked_post_key`);
--> statement-breakpoint
CREATE TABLE `x_activity_metric_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`x_post_id` text NOT NULL,
	`metric_name` text NOT NULL,
	`value` integer NOT NULL,
	`sampled_at` text NOT NULL,
	`import_id` integer,
	`raw_json` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_x_activity_metric_snapshot` ON `x_activity_metric_snapshots` (`x_post_id`,`metric_name`,`sampled_at`);
--> statement-breakpoint
CREATE INDEX `idx_x_activity_metric_history` ON `x_activity_metric_snapshots` (`x_post_id`,`sampled_at`);
--> statement-breakpoint
INSERT OR IGNORE INTO `x_activity_items`
	(`x_post_id`,`kind`,`published_at`,`text`,`url`,`linked_post_key`,`first_seen_at`,`last_seen_at`,`raw_json`)
SELECT
	json_extract(sample.raw_json, '$.x_post_id'),
	'standalone',
	coalesce(target.published_at, post.date_utc),
	coalesce(post.text_en, post.text, ''),
	coalesce(target.url, 'https://x.com/i/web/status/' || json_extract(sample.raw_json, '$.x_post_id')),
	sample.post_key,
	min(sample.sampled_at),
	max(sample.sampled_at),
	json_object('source', 'metric_samples_backfill')
FROM metric_samples AS sample
LEFT JOIN posts AS post ON post.post_key = sample.post_key
LEFT JOIN post_targets AS target ON target.post_key = sample.post_key AND target.target = 'x'
WHERE sample.target = 'x'
	AND json_extract(sample.raw_json, '$.x_post_id') IS NOT NULL
GROUP BY json_extract(sample.raw_json, '$.x_post_id'), sample.post_key;
--> statement-breakpoint
INSERT OR IGNORE INTO `x_activity_metric_snapshots`
	(`x_post_id`,`metric_name`,`value`,`sampled_at`,`import_id`,`raw_json`)
SELECT
	json_extract(raw_json, '$.x_post_id'),
	metric_name,
	coalesce(value, 0),
	sampled_at,
	NULL,
	raw_json
FROM metric_samples
WHERE target = 'x'
	AND json_extract(raw_json, '$.x_post_id') IS NOT NULL;
