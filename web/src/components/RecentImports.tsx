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
            <td>{resultText(run)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
