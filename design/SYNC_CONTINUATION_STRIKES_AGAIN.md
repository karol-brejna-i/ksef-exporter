
Context:
- Several imports had already been made earlier the same day (June, July–August, May),
  and all succeeded with non-zero counts.
- One hypothesis is that the invoices already existed and new ones were skipped, but if
  so the message should say so, and the logs should reflect that.
- Another hypothesis is that the requested window is too broad (the `from` date is too early).
- I need you to analyze the situation and show the root cause. Do not suggest a solution yet.

## How the data looks

Live database: `data/tenants/portowa/ksef-exporter.sqlite` (open read-only).

### `sync_runs` (all rows)

| id  | requested_at        | completed_at             | status  | window_from | window_to  | invoice_count | fetched_count | inserted_count | duplicate_count | categorized_count | needs_review_count | has_more | max_iterations | continuation_before              | continuation_after               | items_inserted_count | items_failed_count | error_type | error_code | http_status | retry_after_seconds | error_message                                                                                                                                                 |
| --- | ------------------- | ------------------------ | ------- | ----------- | ---------- | ------------- | ------------- | -------------- | --------------- | ----------------- | ------------------ | -------- | -------------- | -------------------------------- | -------------------------------- | -------------------- | ------------------ | ---------- | ---------- | ----------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 2026-08-19 15:34:32 | 2026-08-19T15:34:34.983Z | error   | 2026-06-01  | 2026-06-30 | null          | null          | null           | null            | null              | null               | null     | 1              | null                             | null                             | null                 | null               | KsefError  | null       | null        | null                | Authentication failed: 450 Uwierzytelnianie zakończone niepowodzeniem z powodu błędnego tokenu Details: Token nie może być użyty w kontekście nip-9462136075. |
| 2   | 2026-08-19 15:37:36 | 2026-08-19T15:37:43.947Z | success | 2026-06-01  | 2026-06-30 | 145           | 145           | 145            | 0               | 7                 | 138                | 1        | 1              | null                             | 2026-06-29T22:00:00+00:00        | 1377                 | 0                  | null       | null       | null        | null                | null                                                                                                                                                          |
| 3   | 2026-08-19 15:39:11 | 2026-08-19T15:39:16.136Z | success | 2026-07-01  | 2026-08-31 | 265           | 265           | 265            | 0               | 26                | 239                | 1        | 1              | 2026-06-29T22:00:00+00:00        | 2026-08-19T15:37:11.133397+00:00 | 2974                 | 0                  | null       | null       | null        | null                | null                                                                                                                                                          |
| 4   | 2026-08-19 15:39:51 | 2026-08-19T15:39:54.605Z | success | 2026-05-01  | 2026-05-31 | 115           | 115           | 115            | 0               | 1                 | 114                | 1        | 1              | 2026-08-19T15:37:11.133397+00:00 | 2026-08-19T15:37:11.133397+00:00 | 1323                 | 0                  | null       | null       | null        | null                | null                                                                                                                                                          |
| 5   | 2026-08-19 15:52:00 | 2026-08-19T15:52:03.128Z | success | 2026-04-01  | 2026-08-31 | 0             | 0             | 0              | 0               | 0                 | 0                  | 1        | 1              | 2026-08-19T15:37:11.133397+00:00 | 2026-08-19T15:50:01.140543+00:00 | 0                    | 0                  | null       | null       | null        | null                | null                                                                                                                                                          |

### `sync_state`

| subject_type | continuation_point               |
| ------------ | -------------------------------- |
| Subject2     | 2026-08-19T15:50:01.140543+00:00 |

### `invoices` aggregate

| total_invoices | invoices_with_source = 'manual' |
| -------------- | ------------------------------- |
| 525            | 0                               |

## Notes on where the data lives in code

- Import result shown in the UI comes from `web/src/components/SyncButton.tsx` (inline status)
  and `web/src/components/RecentImports.tsx` (the "Requested / Window / Result" table).
- The engine that fetches from KSeF and produces the counts is `src/sync.ts`.
- The `/sync` endpoint and lifecycle logging is `src/api/server.ts`.