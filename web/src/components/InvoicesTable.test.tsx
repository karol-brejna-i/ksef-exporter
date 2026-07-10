import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Category, Invoice } from "../api/client";
import * as apiClient from "../api/client";
import { InvoicesTable } from "./InvoicesTable";

afterEach(() => {
  vi.restoreAllMocks();
});

const categories: Category[] = [
  { id: 1, name: "Media" },
  { id: 2, name: "Inne" },
];

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
    render(
      <InvoicesTable
        invoices={[]}
        categories={categories}
        token="jwt-token"
        onCorrected={vi.fn()}
      />,
    );

    expect(screen.getByText(/no invoices yet/i)).toBeInTheDocument();
  });

  it("renders a row per invoice with its category name", () => {
    render(
      <InvoicesTable
        invoices={[invoice()]}
        categories={categories}
        token="jwt-token"
        onCorrected={vi.fn()}
      />,
    );

    expect(screen.getByText("Energa Operator")).toBeInTheDocument();
    expect(screen.getByText("123.45 PLN")).toBeInTheDocument();
    expect(screen.getByLabelText("Category for Energa Operator")).toHaveValue("1");
  });

  it("visually distinguishes needs_review rows from matched rows", () => {
    render(
      <InvoicesTable
        invoices={[
          invoice({ id: 1, categorizationConfidence: "matched" }),
          invoice({ id: 2, categorizationConfidence: "needs_review", categoryId: null }),
        ]}
        categories={categories}
        token="jwt-token"
        onCorrected={vi.fn()}
      />,
    );

    const matchedRow = screen.getByText("Confident").closest("tr");
    const needsReviewRow = screen.getByText("Needs review").closest("tr");

    expect(matchedRow).toHaveClass("matched");
    expect(needsReviewRow).toHaveClass("needs-review");
  });

  it("corrects the category via the dropdown and calls onCorrected", async () => {
    const corrected = invoice({ categoryId: 2, categorizationConfidence: "matched" });
    vi.spyOn(apiClient, "correctCategory").mockResolvedValue({ invoice: corrected });
    const onCorrected = vi.fn();
    const user = userEvent.setup();

    render(
      <InvoicesTable
        invoices={[invoice()]}
        categories={categories}
        token="jwt-token"
        onCorrected={onCorrected}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Category for Energa Operator"), "2");

    expect(apiClient.correctCategory).toHaveBeenCalledWith("jwt-token", 1, 2);
    await vi.waitFor(() => expect(onCorrected).toHaveBeenCalledWith(corrected));
  });

  it("shows an error message when the correction fails", async () => {
    vi.spyOn(apiClient, "correctCategory").mockRejectedValue(
      new apiClient.ApiError("invoice not found", 404),
    );
    const user = userEvent.setup();

    render(
      <InvoicesTable
        invoices={[invoice()]}
        categories={categories}
        token="jwt-token"
        onCorrected={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Category for Energa Operator"), "2");

    expect(await screen.findByRole("alert")).toHaveTextContent("invoice not found");
  });
});
