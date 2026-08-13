import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Invoice } from "../api/client";
import { InvoicesSummary } from "./InvoicesSummary";

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 1,
    source: "ksef",
    ksefNumber: "5265877635-20250115-123456789012-01",
    invoiceNumber: "FV/1",
    sellerNip: "5265877635",
    sellerName: "Energa Operator",
    buyerNip: "1111111111",
    buyerName: "Parkowa Sp. z o.o.",
    issueDate: "2025-01-15",
    grossTotal: 100,
    currency: "PLN",
    categoryId: 1,
    categorizationConfidence: "matched",
    createdAt: "2025-01-16T00:00:00.000Z",
    itemCount: 0,
    itemsExtractedAt: "2025-01-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("InvoicesSummary", () => {
  it("shows zero counts and a dash total when there are no invoices", () => {
    render(<InvoicesSummary invoices={[]} />);

    expect(screen.getByText("Total invoices").nextElementSibling).toHaveTextContent("0");
    expect(screen.getByText("Needs review").nextElementSibling).toHaveTextContent("0");
    expect(screen.getByText("Total gross").nextElementSibling).toHaveTextContent("—");
  });

  it("counts total invoices and how many need review", () => {
    render(
      <InvoicesSummary
        invoices={[
          invoice({ id: 1, categorizationConfidence: "matched" }),
          invoice({ id: 2, categorizationConfidence: "needs_review" }),
          invoice({ id: 3, categorizationConfidence: "needs_review" }),
        ]}
      />,
    );

    expect(screen.getByText("Total invoices").nextElementSibling).toHaveTextContent("3");
    expect(screen.getByText("Needs review").nextElementSibling).toHaveTextContent("2");
  });

  it("sums gross totals per currency separately", () => {
    render(
      <InvoicesSummary
        invoices={[
          invoice({ id: 1, grossTotal: 100, currency: "PLN" }),
          invoice({ id: 2, grossTotal: 50, currency: "PLN" }),
          invoice({ id: 3, grossTotal: 20, currency: "USD" }),
        ]}
      />,
    );

    expect(screen.getByText("Total gross").nextElementSibling).toHaveTextContent(
      "150.00 PLN, 20.00 USD",
    );
  });
});
