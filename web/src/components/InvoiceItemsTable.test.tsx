import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { InvoiceItem } from "../api/client";
import { InvoiceItemsTable } from "./InvoiceItemsTable";

function item(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    ordinal: 1,
    lineNumber: 1,
    uuId: null,
    deliveryDate: null,
    name: "Test Product",
    indexCode: null,
    gtin: null,
    pkwiu: null,
    cn: null,
    pkob: null,
    unit: "szt.",
    quantity: 10,
    unitPriceNet: 5.0,
    unitPriceGross: 6.15,
    discount: null,
    netValue: 50.0,
    grossValue: 61.5,
    vatValue: 11.5,
    vatRate: "23",
    vatRateOss: null,
    annex15: null,
    excise: null,
    gtuCode: null,
    procedureCode: null,
    exchangeRate: null,
    correctionStateBefore: null,
    ...overrides,
  };
}

describe("InvoiceItemsTable", () => {
  it("shows an empty-state message when there are no items", () => {
    render(<InvoiceItemsTable items={[]} />);

    expect(screen.getByText(/no items recorded/i)).toBeInTheDocument();
  });

  it("renders a row per item with line number, name, unit, quantity, value, VAT rate, and VAT amount", () => {
    render(<InvoiceItemsTable items={[item()]} />);

    expect(screen.getByText("1")).toBeInTheDocument(); // line number
    expect(screen.getByText("Test Product")).toBeInTheDocument();
    expect(screen.getByText("szt.")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("50.00")).toBeInTheDocument(); // netValue
    expect(screen.getByText("23")).toBeInTheDocument();
    expect(screen.getByText("11.50")).toBeInTheDocument(); // vatValue
  });

  it("falls back to gross value when net value is null", () => {
    render(<InvoiceItemsTable items={[item({ netValue: null, grossValue: 61.5 })]} />);

    expect(screen.getByText("61.50")).toBeInTheDocument();
  });

  it("marks correction state before rows", () => {
    render(
      <InvoiceItemsTable
        items={[
          item({ ordinal: 1, lineNumber: 1, correctionStateBefore: true }),
          item({ ordinal: 2, lineNumber: 1, correctionStateBefore: null }),
        ]}
      />,
    );

    expect(screen.getByText(/before correction/i)).toBeInTheDocument();
  });

  it("displays em dash for missing values", () => {
    render(
      <InvoiceItemsTable
        items={[
          item({
            lineNumber: null,
            name: null,
            unit: null,
            quantity: null,
            netValue: null,
            grossValue: null,
            vatRate: null,
            vatValue: null,
          }),
        ]}
      />,
    );

    // Should have multiple em dashes for missing values
    const emDashes = screen.getAllByText("—");
    expect(emDashes.length).toBeGreaterThan(1);
  });

  it("displays VAT rate as text including non-numeric values", () => {
    render(<InvoiceItemsTable items={[item({ vatRate: "zw", netValue: 100, vatValue: 0 })]} />);

    expect(screen.getByText("zw")).toBeInTheDocument();
  });
});
