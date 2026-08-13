import type { InvoiceItem } from "../api/client";

export interface InvoiceItemsTableProps {
  items: InvoiceItem[];
}

export function InvoiceItemsTable({ items }: InvoiceItemsTableProps) {
  if (items.length === 0) {
    return <p>No items recorded</p>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Name</th>
          <th>Unit</th>
          <th>Quantity</th>
          <th>Value</th>
          <th>VAT rate</th>
          <th>VAT amount</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const value = item.netValue ?? item.grossValue;
          const isCorrectionStateBefore = item.correctionStateBefore === true;

          return (
            <tr key={item.ordinal} className={isCorrectionStateBefore ? "correction-before" : ""}>
              <td>{item.lineNumber ?? "—"}</td>
              <td>
                {item.name ?? "—"}
                {isCorrectionStateBefore && (
                  <span style={{ fontStyle: "italic", marginLeft: "0.5em" }}>
                    (before correction)
                  </span>
                )}
              </td>
              <td>{item.unit ?? "—"}</td>
              <td>{item.quantity !== null ? item.quantity : "—"}</td>
              <td>{value !== null ? value.toFixed(2) : "—"}</td>
              <td>{item.vatRate ?? "—"}</td>
              <td>{item.vatValue !== null ? item.vatValue.toFixed(2) : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
