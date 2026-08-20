PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`ksef_number` text,
	`invoice_number` text NOT NULL,
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
	CONSTRAINT "invoices_confidence_enum" CHECK("__new_invoices"."categorization_confidence" IN ('matched', 'needs_review')),
	CONSTRAINT "invoices_currency_iso" CHECK("__new_invoices"."currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "invoices_seller_nip_digits" CHECK("__new_invoices"."seller_nip" IS NULL OR "__new_invoices"."seller_nip" GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
	CONSTRAINT "invoices_buyer_nip_digits" CHECK("__new_invoices"."buyer_nip" IS NULL OR "__new_invoices"."buyer_nip" GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
	CONSTRAINT "invoices_created_at_epoch_ms" CHECK("__new_invoices"."created_at" BETWEEN 946684800000 AND 4102444800000),
	CONSTRAINT "invoices_items_extracted_at_epoch_ms" CHECK("__new_invoices"."items_extracted_at" IS NULL OR "__new_invoices"."items_extracted_at" BETWEEN 946684800000 AND 4102444800000)
);
--> statement-breakpoint
INSERT INTO `__new_invoices`("id", "source", "ksef_number", "invoice_number", "seller_nip", "seller_name", "buyer_nip", "buyer_name", "issue_date", "gross_total", "currency", "raw_xml", "items_extracted_at", "category_id", "categorization_confidence", "created_at") SELECT "id", "source", "ksef_number", "invoice_number", "seller_nip", "seller_name", "buyer_nip", "buyer_name", "issue_date", "gross_total", "currency", "raw_xml", "items_extracted_at", "category_id", "categorization_confidence", "created_at" FROM `invoices`;--> statement-breakpoint
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
	CONSTRAINT "sync_runs_has_more_bool" CHECK("__new_sync_runs"."has_more" IS NULL OR "__new_sync_runs"."has_more" IN (0, 1)),
	CONSTRAINT "sync_runs_window_from_iso" CHECK("__new_sync_runs"."window_from" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND "__new_sync_runs"."window_from" IS date("__new_sync_runs"."window_from")),
	CONSTRAINT "sync_runs_window_to_iso" CHECK("__new_sync_runs"."window_to" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND "__new_sync_runs"."window_to" IS date("__new_sync_runs"."window_to")),
	CONSTRAINT "sync_runs_window_order" CHECK("__new_sync_runs"."window_from" <= "__new_sync_runs"."window_to"),
	CONSTRAINT "sync_runs_requested_at_epoch_ms" CHECK("__new_sync_runs"."requested_at" BETWEEN 946684800000 AND 4102444800000),
	CONSTRAINT "sync_runs_started_at_epoch_ms" CHECK("__new_sync_runs"."started_at" IS NULL OR "__new_sync_runs"."started_at" BETWEEN 946684800000 AND 4102444800000),
	CONSTRAINT "sync_runs_completed_at_epoch_ms" CHECK("__new_sync_runs"."completed_at" IS NULL OR "__new_sync_runs"."completed_at" BETWEEN 946684800000 AND 4102444800000)
);
--> statement-breakpoint
INSERT INTO `__new_sync_runs`("id", "requested_at", "started_at", "completed_at", "duration_ms", "window_from", "window_to", "status", "invoice_count", "error_message", "continuation_before", "continuation_after", "fetched_count", "inserted_count", "duplicate_count", "categorized_count", "needs_review_count", "has_more", "max_iterations", "error_type", "error_code", "http_status", "retry_after_seconds", "items_inserted_count", "items_failed_count") SELECT "id", "requested_at", "started_at", "completed_at", "duration_ms", "window_from", "window_to", "status", "invoice_count", "error_message", "continuation_before", "continuation_after", "fetched_count", "inserted_count", "duplicate_count", "categorized_count", "needs_review_count", "has_more", "max_iterations", "error_type", "error_code", "http_status", "retry_after_seconds", "items_inserted_count", "items_failed_count" FROM `sync_runs`;--> statement-breakpoint
DROP TABLE `sync_runs`;--> statement-breakpoint
ALTER TABLE `__new_sync_runs` RENAME TO `sync_runs`;--> statement-breakpoint
CREATE TABLE `__new_categorization_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_type` text NOT NULL,
	`match_value` text NOT NULL,
	`category_id` integer NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "categorization_rules_match_type_enum" CHECK("__new_categorization_rules"."match_type" IN ('seller_nip', 'seller_name_contains'))
);
--> statement-breakpoint
INSERT INTO `__new_categorization_rules`("id", "match_type", "match_value", "category_id") SELECT "id", "match_type", "match_value", "category_id" FROM `categorization_rules`;--> statement-breakpoint
DROP TABLE `categorization_rules`;--> statement-breakpoint
ALTER TABLE `__new_categorization_rules` RENAME TO `categorization_rules`;--> statement-breakpoint
CREATE UNIQUE INDEX `categorization_rules_match_unique` ON `categorization_rules` (`match_type`,`match_value`);--> statement-breakpoint
CREATE TABLE `__new_invoice_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_id` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`line_number` integer,
	`uu_id` text,
	`delivery_date` text,
	`name` text,
	`index_code` text,
	`gtin` text,
	`pkwiu` text,
	`cn` text,
	`pkob` text,
	`unit` text,
	`quantity` real,
	`unit_price_net` real,
	`unit_price_gross` real,
	`discount` real,
	`net_value` real,
	`gross_value` real,
	`vat_value` real,
	`vat_rate` text,
	`vat_rate_oss` real,
	`annex15` integer,
	`excise` real,
	`gtu_code` text,
	`procedure_code` text,
	`exchange_rate` real,
	`correction_state_before` integer,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "invoice_items_ordinal_positive" CHECK("__new_invoice_items"."ordinal" >= 1),
	CONSTRAINT "invoice_items_delivery_date_iso" CHECK("__new_invoice_items"."delivery_date" IS NULL OR ("__new_invoice_items"."delivery_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND "__new_invoice_items"."delivery_date" IS date("__new_invoice_items"."delivery_date"))),
	CONSTRAINT "invoice_items_annex15_bool" CHECK("__new_invoice_items"."annex15" IS NULL OR "__new_invoice_items"."annex15" IN (0, 1)),
	CONSTRAINT "invoice_items_correction_state_bool" CHECK("__new_invoice_items"."correction_state_before" IS NULL OR "__new_invoice_items"."correction_state_before" IN (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_invoice_items`("id", "invoice_id", "ordinal", "line_number", "uu_id", "delivery_date", "name", "index_code", "gtin", "pkwiu", "cn", "pkob", "unit", "quantity", "unit_price_net", "unit_price_gross", "discount", "net_value", "gross_value", "vat_value", "vat_rate", "vat_rate_oss", "annex15", "excise", "gtu_code", "procedure_code", "exchange_rate", "correction_state_before") SELECT "id", "invoice_id", "ordinal", "line_number", "uu_id", "delivery_date", "name", "index_code", "gtin", "pkwiu", "cn", "pkob", "unit", "quantity", "unit_price_net", "unit_price_gross", "discount", "net_value", "gross_value", "vat_value", "vat_rate", "vat_rate_oss", "annex15", "excise", "gtu_code", "procedure_code", "exchange_rate", "correction_state_before" FROM `invoice_items`;--> statement-breakpoint
DROP TABLE `invoice_items`;--> statement-breakpoint
ALTER TABLE `__new_invoice_items` RENAME TO `invoice_items`;--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_items_invoice_ordinal_unique` ON `invoice_items` (`invoice_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `invoice_items_invoice_id_idx` ON `invoice_items` (`invoice_id`);