CREATE TABLE `device_authorizations` (
	`target` text PRIMARY KEY NOT NULL,
	`sealed_device_code` text NOT NULL,
	`user_code` text NOT NULL,
	`verification_url` text NOT NULL,
	`interval_seconds` integer NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
