import type { Category, Invoice } from "../api/client";

export interface InvoicesTableProps {
  invoices: Invoice[];
  categories: Category[];
}

export function InvoicesTable({ invoices, categories }: InvoicesTableProps) {
  function categoryName(categoryId: number | null): string {
    if (categoryId === null) {
      return "—";
    }
    return categories.find((category) => category.id === categoryId)?.name ?? "—";
  }

  if (invoices.length === 0) {
    return <p>No invoices yet. Click &ldquo;Import invoices&rdquo; to pull invoices from KSeF.</p>;
  }

  return (
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
            <td>{categoryName(invoice.categoryId)}</td>
            <td>
              {invoice.categorizationConfidence === "needs_review" ? "Needs review" : "Confident"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
