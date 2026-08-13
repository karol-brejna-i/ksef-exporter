import { useEffect, useState } from "react";
import { ApiError, fetchSyncRuns, type SyncRun } from "../api/client";

export interface RecentImportsProps {
  token: string;
  /** Bump this after a new sync is triggered to refetch the history. */
  refreshKey: number;
}

function resultText(run: SyncRun): string {
  if (run.status === "success") {
    return `${run.invoiceCount ?? 0} invoice(s)`;
  }
  if (run.status === "error") {
    return `Failed: ${run.errorMessage ?? "unknown error"}`;
  }
  return "In progress…";
}

function countText(value: number | null): string {
  return value === null ? "Not reached" : String(value);
}

function durationText(durationMs: number | null): string {
  return durationMs === null ? "Not completed" : `${(durationMs / 1000).toFixed(1)}s`;
}

function RunDetails({ run }: { run: SyncRun }) {
  return (
    <details>
      <summary>Details</summary>
      <dl>
        <dt>Run ID</dt>
        <dd>{run.id}</dd>
        <dt>Duration</dt>
        <dd>{durationText(run.durationMs)}</dd>
        <dt>Started</dt>
        <dd>{run.startedAt ?? "Not started"}</dd>
        <dt>Completed</dt>
        <dd>{run.completedAt ?? "Not completed"}</dd>
        <dt>Max iterations</dt>
        <dd>{run.maxIterations ?? "Unknown"}</dd>
        <dt>Continuation before</dt>
        <dd>{run.continuationBefore ?? "None"}</dd>
        <dt>Continuation after</dt>
        <dd>{run.continuationAfter ?? "Not reached"}</dd>
        <dt>Fetched</dt>
        <dd>{countText(run.fetchedCount)}</dd>
        <dt>Inserted</dt>
        <dd>{countText(run.insertedCount)}</dd>
        <dt>Duplicates</dt>
        <dd>{countText(run.duplicateCount)}</dd>
        <dt>Categorized</dt>
        <dd>{countText(run.categorizedCount)}</dd>
        <dt>Needs review</dt>
        <dd>{countText(run.needsReviewCount)}</dd>
        <dt>More available</dt>
        <dd>{run.hasMore === null ? "Unknown" : run.hasMore ? "Yes" : "No"}</dd>
        <dt>Items inserted</dt>
        <dd>{countText(run.itemsInsertedCount)}</dd>
        <dt>Items failed</dt>
        <dd>{countText(run.itemsFailedCount)}</dd>
        {run.errorType && (
          <>
            <dt>Error type</dt>
            <dd>{run.errorType}</dd>
          </>
        )}
        {run.httpStatus !== null && (
          <>
            <dt>HTTP status</dt>
            <dd>{run.httpStatus}</dd>
          </>
        )}
        {run.errorCode && (
          <>
            <dt>KSeF error code</dt>
            <dd>{run.errorCode}</dd>
          </>
        )}
        {run.retryAfterSeconds !== null && (
          <>
            <dt>Retry after</dt>
            <dd>{run.retryAfterSeconds} seconds</dd>
          </>
        )}
      </dl>
    </details>
  );
}

/**
 * Import run history (Phase 7, SPEC §2.2 NFR 5): lets the owner confirm an
 * import actually happened and how it went, instead of only ever seeing
 * the resulting invoices with no trace of the request that produced them.
 */
export function RecentImports({ token, refreshKey }: RecentImportsProps) {
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey isn't referenced in the effect body -- it exists purely to force a refetch when bumped by the parent after a new sync is triggered.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSyncRuns(token)
      .then((result) => {
        if (!cancelled) {
          setRuns(result.runs);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Failed to load import history");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, refreshKey]);

  if (loading) {
    return <p>Loading import history…</p>;
  }

  if (error) {
    return <p role="alert">{error}</p>;
  }

  if (runs.length === 0) {
    return <p>No imports yet.</p>;
  }

  return (
    <table>
      <caption>Recent imports</caption>
      <thead>
        <tr>
          <th>Requested</th>
          <th>Window</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id}>
            <td>{new Date(run.requestedAt).toLocaleString()}</td>
            <td>
              {run.windowFrom} – {run.windowTo}
            </td>
            <td>
              {resultText(run)}
              <RunDetails run={run} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
