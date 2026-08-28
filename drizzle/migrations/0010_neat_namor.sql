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
	`net_total` real,
	`vat_total` real,
	`currency` text NOT NULL,
	`payment_due_date` text,
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
	CONSTRAINT "invoices_payment_due_date_iso" CHECK("__new_invoices"."payment_due_date" IS NULL OR ("__new_invoices"."payment_due_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND "__new_invoices"."payment_due_date" IS date("__new_invoices"."payment_due_date"))),
	CONSTRAINT "invoices_confidence_enum" CHECK("__new_invoices"."categorization_confidence" IN ('matched', 'needs_review', 'not_applicable')),
	CONSTRAINT "invoices_currency_iso" CHECK("__new_invoices"."currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "invoices_seller_nip_digits" CHECK("__new_invoices"."seller_nip" IS NULL OR "__new_invoices"."seller_nip" GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
	CONSTRAINT "invoices_buyer_nip_digits" CHECK("__new_invoices"."buyer_nip" IS NULL OR "__new_invoices"."buyer_nip" GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
	CONSTRAINT "invoices_created_at_epoch_ms" CHECK("__new_invoices"."created_at" BETWEEN 946684800000 AND 4102444800000),
	CONSTRAINT "invoices_items_extracted_at_epoch_ms" CHECK("__new_invoices"."items_extracted_at" IS NULL OR "__new_invoices"."items_extracted_at" BETWEEN 946684800000 AND 4102444800000)
);
--> statement-breakpoint
INSERT INTO `__new_invoices`("id", "source", "direction", "ksef_number", "invoice_number", "invoice_kind", "seller_nip", "seller_name", "buyer_nip", "buyer_name", "issue_date", "gross_total", "net_total", "vat_total", "currency", "payment_due_date", "raw_xml", "items_extracted_at", "category_id", "categorization_confidence", "created_at") SELECT "id", "source", "direction", "ksef_number", "invoice_number", "invoice_kind", "seller_nip", "seller_name", "buyer_nip", "buyer_name", "issue_date", "gross_total", NULL, NULL, "currency", NULL, "raw_xml", "items_extracted_at", "category_id", "categorization_confidence", "created_at" FROM `invoices`;--> statement-breakpoint
DROP TABLE `invoices`;--> statement-breakpoint
ALTER TABLE `__new_invoices` RENAME TO `invoices`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_ksef_number_unique` ON `invoices` (`ksef_number`);--> statement-breakpoint
CREATE INDEX `invoices_issue_date_idx` ON `invoices` (`issue_date`);