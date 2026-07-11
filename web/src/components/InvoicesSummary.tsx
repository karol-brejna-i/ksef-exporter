import type { Invoice } from "../api/client";

export interface InvoicesSummaryProps {
  invoices: Invoice[];
}

/** Sums gross totals per currency -- summing across currencies would be misleading. */
function totalsByCurrency(invoices: Invoice[]): Array<{ currency: string; total: number }> {
  const totals = new Map<string, number>();
  for (const invoice of invoices) {
    totals.set(invoice.currency, (totals.get(invoice.currency) ?? 0) + invoice.grossTotal);
  }
  return [...totals.entries()]
    .map(([currency, total]) => ({ currency, total }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/**
 * At-a-glance sanity check above the invoices table (Phase 7, SPEC §2.2 NFR
 * 5): total count, per-currency gross totals, and how many still need
 * review -- so confirming "did the import look right?" doesn't require
 * reading every row.
 */
export function InvoicesSummary({ invoices }: InvoicesSummaryProps) {
  const needsReviewCount = invoices.filter(
    (invoice) => invoice.categorizationConfidence === "needs_review",
  ).length;

  return (
    <dl className="summary-bar">
      <div>
        <dt>Total invoices</dt>
        <dd>{invoices.length}</dd>
      </div>
      <div>
        <dt>Needs review</dt>
        <dd>{needsReviewCount}</dd>
      </div>
      <div>
        <dt>Total gross</dt>
        <dd>
          {invoices.length === 0
            ? "—"
            : totalsByCurrency(invoices)
                .map(({ currency, total }) => `${total.toFixed(2)} ${currency}`)
                .join(", ")}
        </dd>
      </div>
    </dl>
  );
}
