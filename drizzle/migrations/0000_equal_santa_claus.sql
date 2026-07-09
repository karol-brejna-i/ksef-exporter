CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_name_unique` ON `categories` (`name`);--> statement-breakpoint
CREATE TABLE `categorization_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_type` text NOT NULL,
	`match_value` text NOT NULL,
	`category_id` integer NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categorization_rules_match_unique` ON `categorization_rules` (`match_type`,`match_value`);--> statement-breakpoint
CREATE TABLE `invoices` (
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
	`category_id` integer,
	`categorization_confidence` text DEFAULT 'needs_review' NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_ksef_number_unique` ON `invoices` (`ksef_number`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`subject_type` text PRIMARY KEY NOT NULL,
	`continuation_point` text
);
