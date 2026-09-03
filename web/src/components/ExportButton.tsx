import { type ChangeEvent, useState } from "react";
import { ApiError, fetchInvoiceExport } from "../api/client";
import { downloadBlob } from "../downloadBlob";

export interface ExportButtonProps {
  token: string;
}

export function ExportButton({ token }: ExportButtonProps) {
  // Unlike SyncButton's current-month default, "export everything" is the
  // sensible default here, so the range starts unbounded.
  const [{ from, to }, setWindow] = useState({ from: "", to: "" });
  const [status, setStatus] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  function handleFromChange(event: ChangeEvent<HTMLInputElement>): void {
    setWindow((current) => ({ ...current, from: event.target.value }));
  }

  function handleToChange(event: ChangeEvent<HTMLInputElement>): void {
    setWindow((current) => ({ ...current, to: event.target.value }));
  }

  async function handleClick(): Promise<void> {
    setExporting(true);
    setStatus(null);
    try {
      const { blob, filename } = await fetchInvoiceExport(
        token,
        from || undefined,
        to || undefined,
      );
      downloadBlob(blob, filename);
    } catch (err) {
      setStatus(err instanceof ApiError ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <label htmlFor="export-from">
        From
        <input
          id="export-from"
          type="date"
          value={from}
          max={to || undefined}
          onChange={handleFromChange}
        />
      </label>
      <label htmlFor="export-to">
        To
        <input
          id="export-to"
          type="date"
          value={to}
          min={from || undefined}
          onChange={handleToChange}
        />
      </label>
      <button type="button" onClick={() => void handleClick()} disabled={exporting}>
        {exporting ? "Exporting…" : "Export"}
      </button>
      {status && <p role="alert">{status}</p>}
    </div>
  );
}
