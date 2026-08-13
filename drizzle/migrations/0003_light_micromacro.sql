CREATE TABLE `invoice_items` (
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
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_items_invoice_ordinal_unique` ON `invoice_items` (`invoice_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `invoice_items_invoice_id_idx` ON `invoice_items` (`invoice_id`);--> statement-breakpoint
ALTER TABLE `invoices` ADD `items_extracted_at` text;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `items_inserted_count` integer;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `items_failed_count` integer;