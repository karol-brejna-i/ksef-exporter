CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`requested_at` text DEFAULT (current_timestamp) NOT NULL,
	`window_from` text NOT NULL,
	`window_to` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`invoice_count` integer,
	`error_message` text
);
