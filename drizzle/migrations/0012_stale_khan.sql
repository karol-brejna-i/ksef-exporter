PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	`is_truncated` integer,
	`has_more_reason` text,
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
	CONSTRAINT "sync_runs_is_truncated_bool" CHECK("__new_sync_runs"."is_truncated" IS NULL OR "__new_sync_runs"."is_truncated" IN (0, 1)),
	CONSTRAINT "sync_runs_has_more_reason_enum" CHECK("__new_sync_runs"."has_more_reason" IS NULL OR "__new_sync_runs"."has_more_reason" IN ('truncated', 'window_exhausted', 'stalled')),
	CONSTRAINT "sync_runs_window_from_iso" CHECK("__new_sync_runs"."window_from" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND "__new_sync_runs"."window_from" IS date("__new_sync_runs"."window_from")),
	CONSTRAINT "sync_runs_window_to_iso" CHECK("__new_sync_runs"."window_to" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND "__new_sync_runs"."window_to" IS date("__new_sync_runs"."window_to")),
	CONSTRAINT "sync_runs_window_order" CHECK("__new_sync_runs"."window_from" <= "__new_sync_runs"."window_to"),
	CONSTRAINT "sync_runs_requested_at_epoch_ms" CHECK("__new_sync_runs"."requested_at" BETWEEN 946684800000 AND 4102444800000),
	CONSTRAINT "sync_runs_started_at_epoch_ms" CHECK("__new_sync_runs"."started_at" IS NULL OR "__new_sync_runs"."started_at" BETWEEN 946684800000 AND 4102444800000),
	CONSTRAINT "sync_runs_completed_at_epoch_ms" CHECK("__new_sync_runs"."completed_at" IS NULL OR "__new_sync_runs"."completed_at" BETWEEN 946684800000 AND 4102444800000)
);
--> statement-breakpoint
INSERT INTO `__new_sync_runs`("id", "requested_at", "started_at", "completed_at", "duration_ms", "subject_type", "window_from", "window_to", "status", "invoice_count", "error_message", "continuation_before", "continuation_after", "fetched_count", "inserted_count", "duplicate_count", "categorized_count", "needs_review_count", "has_more", "is_truncated", "has_more_reason", "max_iterations", "error_type", "error_code", "http_status", "retry_after_seconds", "items_inserted_count", "items_failed_count") SELECT "id", "requested_at", "started_at", "completed_at", "duration_ms", "subject_type", "window_from", "window_to", "status", "invoice_count", "error_message", "continuation_before", "continuation_after", "fetched_count", "inserted_count", "duplicate_count", "categorized_count", "needs_review_count", "has_more", "is_truncated", "has_more_reason", "max_iterations", "error_type", "error_code", "http_status", "retry_after_seconds", "items_inserted_count", "items_failed_count" FROM `sync_runs`;--> statement-breakpoint
DROP TABLE `sync_runs`;--> statement-breakpoint
ALTER TABLE `__new_sync_runs` RENAME TO `sync_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;