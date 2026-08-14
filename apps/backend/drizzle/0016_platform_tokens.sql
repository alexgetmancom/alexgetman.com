CREATE TABLE `platform_tokens` (
	`target` text PRIMARY KEY NOT NULL,
	`sealed_token` text NOT NULL,
	`env_fingerprint` text NOT NULL,
	`refreshed_at` text NOT NULL,
	`updated_at` text NOT NULL
);
