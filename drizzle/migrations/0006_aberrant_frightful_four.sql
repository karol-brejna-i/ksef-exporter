ALTER TABLE `invoices` DROP COLUMN `items_extracted_at`;--> statement-breakpoint
ALTER TABLE `invoices` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `sync_runs` DROP COLUMN `requested_at`;--> statement-breakpoint
ALTER TABLE `sync_runs` DROP COLUMN `started_at`;--> statement-breakpoint
ALTER TABLE `sync_runs` DROP COLUMN `completed_at`;