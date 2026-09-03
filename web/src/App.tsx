import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  type Category,
  fetchCategories,
  fetchInvoices,
  type Invoice,
  type InvoiceDirection,
} from "./api/client";
import { ExportButton } from "./components/ExportButton";
import { InvoicesSummary } from "./components/InvoicesSummary";
import { InvoicesTable } from "./components/InvoicesTable";
import { LoginForm } from "./components/LoginForm";
import { RecentImports } from "./components/RecentImports";
import { SyncButton } from "./components/SyncButton";

type Screen = "invoices" | "import" | "export";

export function App() {
  // The JWT is kept only in memory (React state), never in localStorage or
  // sessionStorage, to limit exposure to XSS-based token theft. Trade-off:
  // a page refresh always requires logging in again -- acceptable for a
  // single-owner internal tool at this stage.
  const [token, setToken] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Invoices is the default landing view (Phase 7): browsing/reviewing
  // existing data comes before triggering a new import, so a person can
  // always tell what's already there instead of only ever seeing an
  // import button (see design/SPEC.md §2.1 UX principle).
  const [screen, setScreen] = useState<Screen>("invoices");
  // Which direction the Invoices screen shows and Import will sync. Shared
  // across both screens so switching it on Invoices also changes what the
  // next Import click pulls (design/SALES_INVOICES_PLAN.md Step 5).
  const [direction, setDirection] = useState<InvoiceDirection>("purchase");
  // Bumped on every successful sync trigger so RecentImports (rendered on
  // the Import screen) refetches its history without a full page reload.
  const [importRefreshKey, setImportRefreshKey] = useState(0);

  const loadData = useCallback(async (authToken: string, dir: InvoiceDirection): Promise<void> => {
    setLoading(true);
    try {
      const [invoicesResult, categoriesResult] = await Promise.all([
        fetchInvoices(authToken, dir),
        fetchCategories(authToken),
      ]);
      setInvoices(invoicesResult.invoices);
      setCategories(categoriesResult.categories);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load invoices");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (token) {
      void loadData(token, direction);
    }
  }, [token, direction, loadData]);

  function handleCorrected(updated: Invoice): void {
    setInvoices((current) =>
      current.map((invoice) => (invoice.id === updated.id ? updated : invoice)),
    );
  }

  function handleSynced(): void {
    if (!token) {
      return;
    }
    void loadData(token, direction);
    setImportRefreshKey((key) => key + 1);
  }

  if (!token) {
    return <LoginForm onLogin={setToken} />;
  }

  return (
    <main>
      <h1>KSeF Exporter</h1>
      <nav>
        <button
          type="button"
          aria-current={screen === "invoices" ? "page" : undefined}
          onClick={() => setScreen("invoices")}
        >
          Invoices
        </button>
        <button
          type="button"
          aria-current={screen === "import" ? "page" : undefined}
          onClick={() => setScreen("import")}
        >
          Import
        </button>
        <button
          type="button"
          aria-current={screen === "export" ? "page" : undefined}
          onClick={() => setScreen("export")}
        >
          Export
        </button>
      </nav>
      {error && <p role="alert">{error}</p>}
      {screen === "invoices" ? (
        <section aria-label="Invoices">
          <fieldset aria-label="Direction">
            <button
              type="button"
              aria-pressed={direction === "purchase"}
              onClick={() => setDirection("purchase")}
            >
              Purchases
            </button>
            <button
              type="button"
              aria-pressed={direction === "sales"}
              onClick={() => setDirection("sales")}
            >
              Sales
            </button>
          </fieldset>
          <InvoicesSummary invoices={invoices} />
          {loading ? (
            <p>Loading invoices…</p>
          ) : (
            <InvoicesTable
              invoices={invoices}
              categories={categories}
              token={token}
              onCorrected={handleCorrected}
            />
          )}
        </section>
      ) : screen === "export" ? (
        <section aria-label="Export">
          <ExportButton token={token} />
        </section>
      ) : (
        <section aria-label="Import">
          <SyncButton token={token} onSynced={handleSynced} direction={direction} />
          <RecentImports token={token} refreshKey={importRefreshKey} />
        </section>
      )}
    </main>
  );
}
