ALTER TABLE `sync_runs` ADD `started_at` text;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `completed_at` text;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `duration_ms` integer;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `continuation_before` text;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `continuation_after` text;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `fetched_count` integer;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `inserted_count` integer;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `duplicate_count` integer;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `categorized_count` integer;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `needs_review_count` integer;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `has_more` integer;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `max_iterations` integer;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `error_type` text;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `error_code` text;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `http_status` integer;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `retry_after_seconds` integer;