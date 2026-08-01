CREATE TABLE `channel_credentials` (
	`channel_id` text NOT NULL,
	`name` text NOT NULL,
	`value_encrypted` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`channel_id`, `name`)
);
