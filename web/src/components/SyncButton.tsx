import { type ChangeEvent, useState } from "react";
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
  // Defaults to the current month, but editable -- lets the owner import an
  // arbitrary range (e.g. to backfill a missed month) instead of only ever
  // being able to fetch "this month".
  const [{ windowFrom, windowTo }, setWindow] = useState(currentMonthWindow);
  const [status, setStatus] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  function handleFromChange(event: ChangeEvent<HTMLInputElement>): void {
    setWindow((current) => ({ ...current, windowFrom: event.target.value }));
  }

  function handleToChange(event: ChangeEvent<HTMLInputElement>): void {
    setWindow((current) => ({ ...current, windowTo: event.target.value }));
  }

  async function handleClick(): Promise<void> {
    setSyncing(true);
    setStatus(null);
    try {
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
      <label htmlFor="sync-window-from">
        From
        <input
          id="sync-window-from"
          type="date"
          value={windowFrom}
          max={windowTo}
          onChange={handleFromChange}
        />
      </label>
      <label htmlFor="sync-window-to">
        To
        <input
          id="sync-window-to"
          type="date"
          value={windowTo}
          min={windowFrom}
          onChange={handleToChange}
        />
      </label>
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={syncing || !windowFrom || !windowTo}
      >
        {syncing ? "Importing…" : "Import invoices"}
      </button>
      {status && <p>{status}</p>}
    </div>
  );
}
