CREATE TABLE `channel_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`locale` text NOT NULL,
	`provider` text NOT NULL,
	`provider_account_id` text,
	`label` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`source` text DEFAULT 'config' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_channel_connections_enabled` ON `channel_connections` (`enabled`,`platform`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_channel_connections_route` ON `channel_connections` (`platform`,`locale`,`provider`,`provider_account_id`);
