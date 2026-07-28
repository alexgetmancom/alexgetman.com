ALTER TABLE `channel_connections` ADD `target_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_channel_connections_target` ON `channel_connections` (`target_id`);
