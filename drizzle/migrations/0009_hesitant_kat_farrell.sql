-- drizzle-kit generate produces this exact table rebuild (adding invoices.direction,
-- invoices.invoice_kind, extending categorization_confidence's CHECK with
-- 'not_applicable', and adding sync_runs.subject_type all force a rebuild in SQLite,
-- since CHECK constraints cannot be altered) but with a bug: its INSERT...SELECT
-- copies the brand-new columns BY NAME from the pre-migration table, where they do
-- not exist yet ("no such column: direction"). This file is the same rebuild with
-- literal values substituted for the new columns in the two SELECT lists instead.
-- See design/SALES_INVOICES_PLAN.md Stage 2.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`direction` text DEFAULT 'purchase' NOT NULL,
	`ksef_number` text,
	`invoice_number` text NOT NULL,
	`invoice_kind` text,
	`seller_nip` text,
	`seller_name` text NOT NULL,
	`buyer_nip` text,
	`buyer_name` text,
	`issue_date` text NOT NULL,
	`gross_total` real NOT NULL,
	`currency` text NOT NULL,
	`raw_xml` text,
	`items_extracted_at` integer,
	`category_id` integer,
	`categorization_confidence` text DEFAULT 'needs_review' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invoices_issue_date_iso" CHECK("__new_invoices"."issue_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND "__new_invoices"."issue_date" IS date("__new_invoices"."issue_date")),
	CONSTRAINT "invoices_source_enum" CHECK("__new_invoices"."source" IN ('ksef', 'manual')),
	CONSTRAINT "invoices_direction_enum" CHECK("__new_invoices"."direction" IN ('purchase', 'sales')),
	CONSTRAINT "invoices_invoice_kind_enum" CHECK("__new_invoices"."invoice_kind" IS NULL OR "__new_invoices"."invoice_kind" IN ('VAT', 'KOR', 'ZAL', 'ROZ', 'UPR', 'KOR_ZAL', 'KOR_ROZ')),
	CONSTRAINT "invoices_confidence_enum" CHECK("__new_invoices"."categorization_confidence" IN ('matched', 'needs_review', 'not_applicable')),
	CONSTRAINT "invoices_currency_iso" CHECK("__new_invoices"."currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "invoices_seller_nip_digits" CHECK("__new_invoices"."seller_nip" IS NULL OR "__new_invoices"."seller_nip" GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
	CONSTRAINT "invoices_buyer_nip_digits" CHECK("__new_invoices"."buyer_nip" IS NULL OR "__new_invoices"."buyer_nip" GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
	CONSTRAINT "invoices_created_at_epoch_ms" CHECK("__new_invoices"."created_at" BETWEEN 946684800000 AND 4102444800000),
	CONSTRAINT "invoices_items_extracted_at_epoch_ms" CHECK("__new_invoices"."items_extracted_at" IS NULL OR "__new_invoices"."items_extracted_at" BETWEEN 946684800000 AND 4102444800000)
);
--> statement-breakpoint
INSERT INTO `__new_invoices`("id", "source", "direction", "ksef_number", "invoice_number", "invoice_kind", "seller_nip", "seller_name", "buyer_nip", "buyer_name", "issue_date", "gross_total", "currency", "raw_xml", "items_extracted_at", "category_id", "categorization_confidence", "created_at") SELECT "id", "source", 'purchase', "ksef_number", "invoice_number", NULL, "seller_nip", "seller_name", "buyer_nip", "buyer_name", "issue_date", "gross_total", "currency", "raw_xml", "items_extracted_at", "category_id", "categorization_confidence", "created_at" FROM `invoices`;--> statement-breakpoint
DROP TABLE `invoices`;--> statement-breakpoint
ALTER TABLE `__new_invoices` RENAME TO `invoices`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_ksef_number_unique` ON `invoices` (`ksef_number`);--> statement-breakpoint
CREATE INDEX `invoices_issue_date_idx` ON `invoices` (`issue_date`);--> statement-breakpoint
CREATE TABLE `__new_sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`requested_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`duration_ms` integer,
	`subject_type` text,
	`window_from` text NOT NULL,
	`window_to` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`invoice_count` integer,
	`error_message` text,
	`continuation_before` text,
	`continuation_after` text,
	`fetched_count` integer,
	`inserted_count` integer,
	`duplicate_count` integer,
	`categorized_count` integer,
	`needs_review_count` integer,
	`has_more` integer,
	`max_iterations` integer,
	`error_type` text,
	`error_code` text,
	`http_status` integer,
	`retry_after_seconds` integer,
	`items_inserted_count` integer,
	`items_failed_count` integer,
	CONSTRAINT "sync_runs_status_enum" CHECK("__new_sync_runs"."status" IN ('running', 'success', 'error')),
	CONSTRAINT "sync_runs_subject_type_enum" CHECK("__new_sync_runs"."subject_type" IS NULL OR "__new_sync_runs"."subject_type" IN ('Subject1', 'Subject2')),
	CONSTRAINT "sync_runs_has_more_bool" CHECK("__new_sync_runs"."has_more" IS NULL OR "__new_sync_runs"."has_more" IN (0, 1)),
	CONSTRAINT "sync_runs_window_from_iso" CHECK("__new_sync_runs"."window_from" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND "__new_sync_runs"."window_from" IS date("__new_sync_runs"."window_from")),
	CONSTRAINT "sync_runs_window_to_iso" CHECK("__new_sync_runs"."window_to" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND "__new_sync_runs"."window_to" IS date("__new_sync_runs"."window_to")),
	CONSTRAINT "sync_runs_window_order" CHECK("__new_sync_runs"."window_from" <= "__new_sync_runs"."window_to"),
	CONSTRAINT "sync_runs_requested_at_epoch_ms" CHECK("__new_sync_runs"."requested_at" BETWEEN 946684800000 AND 4102444800000),
	CONSTRAINT "sync_runs_started_at_epoch_ms" CHECK("__new_sync_runs"."started_at" IS NULL OR "__new_sync_runs"."started_at" BETWEEN 946684800000 AND 4102444800000),
	CONSTRAINT "sync_runs_completed_at_epoch_ms" CHECK("__new_sync_runs"."completed_at" IS NULL OR "__new_sync_runs"."completed_at" BETWEEN 946684800000 AND 4102444800000)
);
--> statement-breakpoint
INSERT INTO `__new_sync_runs`("id", "requested_at", "started_at", "completed_at", "duration_ms", "subject_type", "window_from", "window_to", "status", "invoice_count", "error_message", "continuation_before", "continuation_after", "fetched_count", "inserted_count", "duplicate_count", "categorized_count", "needs_review_count", "has_more", "max_iterations", "error_type", "error_code", "http_status", "retry_after_seconds", "items_inserted_count", "items_failed_count") SELECT "id", "requested_at", "started_at", "completed_at", "duration_ms", NULL, "window_from", "window_to", "status", "invoice_count", "error_message", "continuation_before", "continuation_after", "fetched_count", "inserted_count", "duplicate_count", "categorized_count", "needs_review_count", "has_more", "max_iterations", "error_type", "error_code", "http_status", "retry_after_seconds", "items_inserted_count", "items_failed_count" FROM `sync_runs`;--> statement-breakpoint
DROP TABLE `sync_runs`;--> statement-breakpoint
ALTER TABLE `__new_sync_runs` RENAME TO `sync_runs`;
