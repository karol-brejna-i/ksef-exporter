import { useState } from "react";
import { ApiError, triggerSync } from "../api/client";

export interface SyncButtonProps {
  token: string;
  onSynced: () => void;
}

/** First and last calendar day of the current month, as ISO date strings. */
function currentMonthWindow(): { windowFrom: string; windowTo: string } {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const isoDate = (date: Date): string => date.toISOString().slice(0, 10);
  return { windowFrom: isoDate(from), windowTo: isoDate(to) };
}

export function SyncButton({ token, onSynced }: SyncButtonProps) {
  const [status, setStatus] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  async function handleClick(): Promise<void> {
    setSyncing(true);
    setStatus(null);
    try {
      const { windowFrom, windowTo } = currentMonthWindow();
      const result = await triggerSync(token, windowFrom, windowTo);
      setStatus(`Synced ${result.invoiceCount} invoice(s).`);
      onSynced();
    } catch (err) {
      setStatus(err instanceof ApiError ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div>
      <button type="button" onClick={() => void handleClick()} disabled={syncing}>
        {syncing ? "Fetching…" : "Fetch this month"}
      </button>
      {status && <p>{status}</p>}
    </div>
  );
}
