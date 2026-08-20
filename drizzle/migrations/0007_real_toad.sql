ALTER TABLE `invoices` RENAME COLUMN "items_extracted_at_ms" TO "items_extracted_at";--> statement-breakpoint
ALTER TABLE `invoices` RENAME COLUMN "created_at_ms" TO "created_at";--> statement-breakpoint
ALTER TABLE `sync_runs` RENAME COLUMN "requested_at_ms" TO "requested_at";--> statement-breakpoint
ALTER TABLE `sync_runs` RENAME COLUMN "started_at_ms" TO "started_at";--> statement-breakpoint
ALTER TABLE `sync_runs` RENAME COLUMN "completed_at_ms" TO "completed_at";