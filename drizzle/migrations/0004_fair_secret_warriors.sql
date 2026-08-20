ALTER TABLE `invoices` ADD `items_extracted_at_ms` integer;--> statement-breakpoint
ALTER TABLE `invoices` ADD `created_at_ms` integer;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `requested_at_ms` integer;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `started_at_ms` integer;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `completed_at_ms` integer;