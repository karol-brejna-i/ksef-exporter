import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Category, Invoice, InvoiceItem } from "../api/client";
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
    itemCount: 0,
    itemsExtractedAt: "2025-01-16T00:00:00.000Z",
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

  it("items details are collapsed by default with the count in the summary", () => {
    render(
      <InvoicesTable
        invoices={[invoice({ itemCount: 5 })]}
        categories={categories}
        token="jwt-token"
        onCorrected={vi.fn()}
      />,
    );

    const summary = screen.getByText("Items (5)");
    expect(summary).toBeInTheDocument();
    const details = summary.closest("details");
    expect(details).not.toHaveAttribute("open");
  });

  it("fetches items on first expand and not on re-expand", async () => {
    const items: InvoiceItem[] = [
      {
        ordinal: 1,
        lineNumber: 1,
        uuId: null,
        deliveryDate: null,
        name: "Test Item",
        indexCode: null,
        gtin: null,
        pkwiu: null,
        cn: null,
        pkob: null,
        unit: "szt.",
        quantity: 1,
        unitPriceNet: 10,
        unitPriceGross: 12.3,
        discount: null,
        netValue: 10,
        grossValue: 12.3,
        vatValue: 2.3,
        vatRate: "23",
        vatRateOss: null,
        annex15: null,
        excise: null,
        gtuCode: null,
        procedureCode: null,
        exchangeRate: null,
        correctionStateBefore: null,
      },
    ];
    const fetchSpy = vi.spyOn(apiClient, "fetchInvoiceItems").mockResolvedValue({ items });
    const user = userEvent.setup();

    render(
      <InvoicesTable
        invoices={[invoice({ id: 1, itemCount: 1 })]}
        categories={categories}
        token="jwt-token"
        onCorrected={vi.fn()}
      />,
    );

    const summary = screen.getByText("Items (1)");
    const details = summary.closest("details");

    // First expand
    await user.click(summary);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith("jwt-token", 1));
    expect(await screen.findByText("Test Item")).toBeInTheDocument();

    // Collapse
    if (details) {
      await user.click(summary);
    }

    // Re-expand
    await user.click(summary);
    await waitFor(() => expect(screen.getByText("Test Item")).toBeInTheDocument());

    // Should only have been called once
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("displays loading state while fetching items", async () => {
    vi.spyOn(apiClient, "fetchInvoiceItems").mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();

    render(
      <InvoicesTable
        invoices={[invoice({ itemCount: 5 })]}
        categories={categories}
        token="jwt-token"
        onCorrected={vi.fn()}
      />,
    );

    const summary = screen.getByText("Items (5)");
    await user.click(summary);

    expect(screen.getByText(/loading items/i)).toBeInTheDocument();
  });

  it("displays API error when fetching items fails", async () => {
    vi.spyOn(apiClient, "fetchInvoiceItems").mockRejectedValue(
      new apiClient.ApiError("failed to fetch items", 500),
    );
    const user = userEvent.setup();

    render(
      <InvoicesTable
        invoices={[invoice({ itemCount: 5 })]}
        categories={categories}
        token="jwt-token"
        onCorrected={vi.fn()}
      />,
    );

    const summary = screen.getByText("Items (5)");
    await user.click(summary);

    expect(await screen.findByRole("alert")).toHaveTextContent("failed to fetch items");
  });

  it("shows 'Items not extracted yet' when items have never been extracted", () => {
    render(
      <InvoicesTable
        invoices={[invoice({ itemsExtractedAt: null, itemCount: 0 })]}
        categories={categories}
        token="jwt-token"
        onCorrected={vi.fn()}
      />,
    );

    expect(screen.getByText("Items not extracted yet")).toBeInTheDocument();
    // Should not have a details element for this invoice
    const itemsText = screen.getByText("Items not extracted yet");
    expect(itemsText.closest("details")).toBeNull();
  });

  it("shows 'No items recorded' when extraction ran but found no items", () => {
    render(
      <InvoicesTable
        invoices={[invoice({ itemsExtractedAt: "2025-01-16T00:00:00.000Z", itemCount: 0 })]}
        categories={categories}
        token="jwt-token"
        onCorrected={vi.fn()}
      />,
    );

    expect(screen.getByText("No items recorded")).toBeInTheDocument();
    // Should not have a details element for this invoice
    const itemsText = screen.getByText("No items recorded");
    expect(itemsText.closest("details")).toBeNull();
  });

  it("does not fetch items for never-extracted invoices", async () => {
    const fetchSpy = vi.spyOn(apiClient, "fetchInvoiceItems");
    const user = userEvent.setup();

    render(
      <InvoicesTable
        invoices={[invoice({ itemsExtractedAt: null, itemCount: 0 })]}
        categories={categories}
        token="jwt-token"
        onCorrected={vi.fn()}
      />,
    );

    const itemsText = screen.getByText("Items not extracted yet");
    // Try to click it (though it's not clickable, this confirms it doesn't respond)
    await user.click(itemsText);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not fetch items for extracted-but-empty invoices", async () => {
    const fetchSpy = vi.spyOn(apiClient, "fetchInvoiceItems");
    const user = userEvent.setup();

    render(
      <InvoicesTable
        invoices={[invoice({ itemsExtractedAt: "2025-01-16T00:00:00.000Z", itemCount: 0 })]}
        categories={categories}
        token="jwt-token"
        onCorrected={vi.fn()}
      />,
    );

    const itemsText = screen.getByText("No items recorded");
    // Try to click it (though it's not clickable, this confirms it doesn't respond)
    await user.click(itemsText);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
