ALTER TABLE `invoices` ADD `sync_run_id` integer REFERENCES sync_runs(id);--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `is_truncated` integer;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `has_more_reason` text;