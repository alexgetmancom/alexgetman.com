-- Instagram is one connection. The account row now carries the Story target as
-- well as the Reel, so a separate `instagram_stories` row is a second name for
-- the same account, connected and reported apart from it. Fold each one into
-- its account row where that account is not connected yet, then drop them.
INSERT INTO `channel_connections` (`id`, `platform`, `locale`, `provider`, `provider_account_id`, `target_id`, `label`, `enabled`, `source`, `created_at`, `updated_at`)
SELECT
	'instagram_' || `story`.`locale`,
	'instagram',
	`story`.`locale`,
	`story`.`provider`,
	`story`.`provider_account_id`,
	NULL,
	'Instagram ' || UPPER(`story`.`locale`),
	`story`.`enabled`,
	`story`.`source`,
	`story`.`created_at`,
	`story`.`updated_at`
FROM `channel_connections` AS `story`
WHERE `story`.`platform` = 'instagram_stories'
	AND NOT EXISTS (
		SELECT 1 FROM `channel_connections` AS `account`
		WHERE `account`.`platform` = 'instagram' AND `account`.`locale` = `story`.`locale`
	);
--> statement-breakpoint
DELETE FROM `channel_connections` WHERE `platform` = 'instagram_stories';
