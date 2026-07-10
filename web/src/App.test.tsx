import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import * as apiClient from "./api/client";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App", () => {
  it("shows the login screen first, then the invoice table after logging in", async () => {
    vi.spyOn(apiClient, "login").mockResolvedValue({ token: "jwt-token" });
    vi.spyOn(apiClient, "fetchCategories").mockResolvedValue({
      categories: [{ id: 1, name: "Media" }],
    });
    vi.spyOn(apiClient, "fetchInvoices").mockResolvedValue({
      invoices: [
        {
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
        },
      ],
    });
    const user = userEvent.setup();

    render(<App />);

    expect(screen.getByRole("form", { name: /login/i })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Username"), "owner");
    await user.type(screen.getByLabelText("Password"), "a-strong-password");
    await user.click(screen.getByRole("button", { name: /log in/i }));

    expect(await screen.findByText("Energa Operator")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /import invoices/i })).toBeInTheDocument();
  });
});
