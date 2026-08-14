CREATE TABLE `platform_tokens_next` (
	`target` text PRIMARY KEY NOT NULL,
	`sealed_token` text NOT NULL,
	`seed_fingerprint` text,
	`account_id` text,
	`refreshed_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `platform_tokens_next` (`target`, `sealed_token`, `seed_fingerprint`, `refreshed_at`, `updated_at`)
SELECT `target`, `sealed_token`, `env_fingerprint`, `refreshed_at`, `updated_at` FROM `platform_tokens`;
--> statement-breakpoint
DROP TABLE `platform_tokens`;
--> statement-breakpoint
ALTER TABLE `platform_tokens_next` RENAME TO `platform_tokens`;
