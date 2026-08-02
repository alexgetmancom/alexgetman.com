CREATE TABLE `runtime_memory_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`observed_at` text NOT NULL,
	`process_started_at` text NOT NULL,
	`revision` text,
	`rss_bytes` integer NOT NULL,
	`heap_used_bytes` integer NOT NULL,
	`heap_total_bytes` integer NOT NULL,
	`external_bytes` integer NOT NULL,
	`cgroup_current_bytes` integer,
	`cgroup_peak_bytes` integer,
	`cgroup_limit_bytes` integer,
	`cgroup_anon_bytes` integer,
	`cgroup_file_bytes` integer
);
--> statement-breakpoint
CREATE INDEX `idx_runtime_memory_samples_observed_at` ON `runtime_memory_samples` (`observed_at`);
