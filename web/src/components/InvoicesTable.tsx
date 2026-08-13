import { type ChangeEvent, type SyntheticEvent, useState } from "react";
import {
  ApiError,
  type Category,
  correctCategory,
  fetchInvoiceItems,
  type Invoice,
  type InvoiceItem,
} from "../api/client";
import { InvoiceItemsTable } from "./InvoiceItemsTable";

export interface InvoicesTableProps {
  invoices: Invoice[];
  categories: Category[];
  token: string;
  onCorrected: (invoice: Invoice) => void;
}

const UNCATEGORIZED = "uncategorized";

export function InvoicesTable({ invoices, categories, token, onCorrected }: InvoicesTableProps) {
  const [correctingId, setCorrectingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [itemsCache, setItemsCache] = useState<Map<number, InvoiceItem[]>>(new Map());
  const [loadingItems, setLoadingItems] = useState<Set<number>>(new Set());
  const [itemsErrors, setItemsErrors] = useState<Map<number, string>>(new Map());

  async function handleCategoryChange(
    invoiceId: number,
    event: ChangeEvent<HTMLSelectElement>,
  ): Promise<void> {
    const value = event.target.value;
    if (value === UNCATEGORIZED) {
      return;
    }

    setCorrectingId(invoiceId);
    setError(null);
    try {
      const { invoice } = await correctCategory(token, invoiceId, Number(value));
      onCorrected(invoice);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update category");
    } finally {
      setCorrectingId(null);
    }
  }

  async function handleDetailsToggle(
    invoiceId: number,
    event: SyntheticEvent<HTMLDetailsElement>,
  ): Promise<void> {
    const isOpen = event.currentTarget.open;
    if (!isOpen) {
      return;
    }

    // Already cached
    if (itemsCache.has(invoiceId)) {
      return;
    }

    // Already loading
    if (loadingItems.has(invoiceId)) {
      return;
    }

    setLoadingItems((prev) => new Set(prev).add(invoiceId));
    setItemsErrors((prev) => {
      const next = new Map(prev);
      next.delete(invoiceId);
      return next;
    });

    try {
      const { items } = await fetchInvoiceItems(token, invoiceId);
      setItemsCache((prev) => new Map(prev).set(invoiceId, items));
    } catch (err) {
      setItemsErrors((prev) =>
        new Map(prev).set(
          invoiceId,
          err instanceof ApiError ? err.message : "Failed to load items",
        ),
      );
    } finally {
      setLoadingItems((prev) => {
        const next = new Set(prev);
        next.delete(invoiceId);
        return next;
      });
    }
  }

  if (invoices.length === 0) {
    return <p>No invoices yet. Click &ldquo;Import invoices&rdquo; to pull invoices from KSeF.</p>;
  }

  return (
    <>
      {error && <p role="alert">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Seller</th>
            <th>Amount</th>
            <th>Category</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((invoice) => {
            const cachedItems = itemsCache.get(invoice.id);
            const isLoadingItems = loadingItems.has(invoice.id);
            const itemsError = itemsErrors.get(invoice.id);

            return (
              <tr
                key={invoice.id}
                className={
                  invoice.categorizationConfidence === "needs_review" ? "needs-review" : "matched"
                }
              >
                <td>{invoice.issueDate}</td>
                <td>{invoice.sellerName}</td>
                <td>
                  {invoice.grossTotal.toFixed(2)} {invoice.currency}
                </td>
                <td>
                  <select
                    aria-label={`Category for ${invoice.sellerName}`}
                    value={invoice.categoryId ?? UNCATEGORIZED}
                    disabled={correctingId === invoice.id}
                    onChange={(event) => void handleCategoryChange(invoice.id, event)}
                  >
                    <option value={UNCATEGORIZED} disabled>
                      —
                    </option>
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {invoice.categorizationConfidence === "needs_review"
                    ? "Needs review"
                    : "Confident"}
                  {invoice.itemsExtractedAt === null ? (
                    <div style={{ color: "gray" }}>Items not extracted yet</div>
                  ) : invoice.itemCount === 0 ? (
                    <div style={{ color: "gray" }}>No items recorded</div>
                  ) : (
                    <details onToggle={(event) => void handleDetailsToggle(invoice.id, event)}>
                      <summary>Items ({invoice.itemCount})</summary>
                      {isLoadingItems && <p>Loading items…</p>}
                      {itemsError && <p role="alert">{itemsError}</p>}
                      {cachedItems && <InvoiceItemsTable items={cachedItems} />}
                    </details>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
