import { type ChangeEvent, useState } from "react";
import { ApiError, type Category, correctCategory, type Invoice } from "../api/client";

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
          {invoices.map((invoice) => (
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
                {invoice.categorizationConfidence === "needs_review" ? "Needs review" : "Confident"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
