import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Category, Invoice } from "../api/client";
import { InvoicesTable } from "./InvoicesTable";

const categories: Category[] = [{ id: 1, name: "Media" }];

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
    grossTotal: 123.45,
    currency: "PLN",
    categoryId: 1,
    categorizationConfidence: "matched",
    createdAt: "2025-01-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("InvoicesTable", () => {
  it("shows an empty-state message when there are no invoices", () => {
    render(<InvoicesTable invoices={[]} categories={categories} />);

    expect(screen.getByText(/no invoices yet/i)).toBeInTheDocument();
  });

  it("renders a row per invoice with its category name", () => {
    render(<InvoicesTable invoices={[invoice()]} categories={categories} />);

    expect(screen.getByText("Energa Operator")).toBeInTheDocument();
    expect(screen.getByText("Media")).toBeInTheDocument();
    expect(screen.getByText("123.45 PLN")).toBeInTheDocument();
  });

  it("visually distinguishes needs_review rows from matched rows", () => {
    render(
      <InvoicesTable
        invoices={[
          invoice({ id: 1, categorizationConfidence: "matched" }),
          invoice({ id: 2, categorizationConfidence: "needs_review", categoryId: null }),
        ]}
        categories={categories}
      />,
    );

    const matchedRow = screen.getByText("Confident").closest("tr");
    const needsReviewRow = screen.getByText("Needs review").closest("tr");

    expect(matchedRow).toHaveClass("matched");
    expect(needsReviewRow).toHaveClass("needs-review");
  });
});
