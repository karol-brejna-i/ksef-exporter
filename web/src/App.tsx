import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  type Category,
  fetchCategories,
  fetchInvoices,
  type Invoice,
} from "./api/client";
import { InvoicesTable } from "./components/InvoicesTable";
import { LoginForm } from "./components/LoginForm";
import { SyncButton } from "./components/SyncButton";

export function App() {
  // The JWT is kept only in memory (React state), never in localStorage or
  // sessionStorage, to limit exposure to XSS-based token theft. Trade-off:
  // a page refresh always requires logging in again -- acceptable for a
  // single-owner internal tool at this stage.
  const [token, setToken] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async (authToken: string): Promise<void> => {
    try {
      const [invoicesResult, categoriesResult] = await Promise.all([
        fetchInvoices(authToken),
        fetchCategories(authToken),
      ]);
      setInvoices(invoicesResult.invoices);
      setCategories(categoriesResult.categories);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load invoices");
    }
  }, []);

  useEffect(() => {
    if (token) {
      void loadData(token);
    }
  }, [token, loadData]);

  function handleCorrected(updated: Invoice): void {
    setInvoices((current) =>
      current.map((invoice) => (invoice.id === updated.id ? updated : invoice)),
    );
  }

  if (!token) {
    return <LoginForm onLogin={setToken} />;
  }

  return (
    <main>
      <h1>KSeF Exporter</h1>
      {error && <p role="alert">{error}</p>}
      <SyncButton token={token} onSynced={() => void loadData(token)} />
      <InvoicesTable
        invoices={invoices}
        categories={categories}
        token={token}
        onCorrected={handleCorrected}
      />
    </main>
  );
}
