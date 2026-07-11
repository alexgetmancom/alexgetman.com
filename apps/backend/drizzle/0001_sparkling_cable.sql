PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_likes` (
	`post_id` text NOT NULL,
	`ip_hash` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`post_id`, `ip_hash`)
);
--> statement-breakpoint
INSERT INTO `__new_likes`("post_id", "ip_hash", "created_at") SELECT "post_id", "ip_hash", "created_at" FROM `likes`;--> statement-breakpoint
DROP TABLE `likes`;--> statement-breakpoint
ALTER TABLE `__new_likes` RENAME TO `likes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;