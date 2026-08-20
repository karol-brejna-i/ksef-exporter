-- Backfill the instant columns added by 0004, in SQL rather than TypeScript.
--
-- This must not be done in JavaScript. The legacy `current_timestamp` values are
-- UTC in a space-separated form that SQLite reads as UTC (correct) and V8 reads
-- as local time (wrong, by the local offset). A JS backfill would bake that
-- two-hour error permanently into the data.
--
-- julianday() parses every format present here -- 'T' or space separator, 'Z' or
-- an explicit offset, and sub-second digits, truncating microseconds correctly --
-- and is exact to the millisecond for all of them (verified against SQLite
-- 3.53.0; see design/SCHEMA_TYPES_PLAN.md §2.4). julianday(NULL) is NULL, so
-- rows with no recorded timing stay NULL without a CASE.

UPDATE invoices SET
  created_at_ms         = CAST(ROUND((julianday(created_at)         - 2440587.5) * 86400000.0) AS INTEGER),
  items_extracted_at_ms = CAST(ROUND((julianday(items_extracted_at) - 2440587.5) * 86400000.0) AS INTEGER);
--> statement-breakpoint
UPDATE sync_runs SET
  requested_at_ms = CAST(ROUND((julianday(requested_at) - 2440587.5) * 86400000.0) AS INTEGER),
  started_at_ms   = CAST(ROUND((julianday(started_at)   - 2440587.5) * 86400000.0) AS INTEGER),
  completed_at_ms = CAST(ROUND((julianday(completed_at) - 2440587.5) * 86400000.0) AS INTEGER);