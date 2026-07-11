import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import * as apiClient from "./api/client";

afterEach(() => {
  vi.restoreAllMocks();
});

const SAMPLE_INVOICE: apiClient.Invoice = {
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
};

async function logIn(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText("Username"), "owner");
  await user.type(screen.getByLabelText("Password"), "a-strong-password");
  await user.click(screen.getByRole("button", { name: /log in/i }));
}

describe("App", () => {
  it("shows the login screen first, then lands on the invoices view by default after logging in", async () => {
    vi.spyOn(apiClient, "login").mockResolvedValue({ token: "jwt-token" });
    vi.spyOn(apiClient, "fetchCategories").mockResolvedValue({
      categories: [{ id: 1, name: "Media" }],
    });
    vi.spyOn(apiClient, "fetchInvoices").mockResolvedValue({ invoices: [SAMPLE_INVOICE] });
    const user = userEvent.setup();

    render(<App />);

    expect(screen.getByRole("form", { name: /login/i })).toBeInTheDocument();

    await logIn(user);

    // Lands on the Invoices view by default -- not the import screen.
    expect(await screen.findByText("Energa Operator")).toBeInTheDocument();
    expect(screen.getByText("Total invoices").nextElementSibling).toHaveTextContent("1");
    expect(screen.queryByRole("button", { name: /import invoices/i })).not.toBeInTheDocument();
  });

  it("shows a loading state while the initial invoices fetch is in flight", async () => {
    vi.spyOn(apiClient, "login").mockResolvedValue({ token: "jwt-token" });
    vi.spyOn(apiClient, "fetchCategories").mockResolvedValue({ categories: [] });
    vi.spyOn(apiClient, "fetchInvoices").mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();

    render(<App />);
    await logIn(user);

    expect(await screen.findByText(/loading invoices/i)).toBeInTheDocument();
  });

  it("navigates to the Import screen and shows the sync trigger and recent imports", async () => {
    vi.spyOn(apiClient, "login").mockResolvedValue({ token: "jwt-token" });
    vi.spyOn(apiClient, "fetchCategories").mockResolvedValue({ categories: [] });
    vi.spyOn(apiClient, "fetchInvoices").mockResolvedValue({ invoices: [] });
    vi.spyOn(apiClient, "fetchSyncRuns").mockResolvedValue({ runs: [] });
    const user = userEvent.setup();

    render(<App />);
    await logIn(user);
    await screen.findByText(/no invoices yet/i);

    await user.click(screen.getByRole("button", { name: "Import" }));

    expect(screen.getByRole("button", { name: /import invoices/i })).toBeInTheDocument();
    expect(await screen.findByText(/no imports yet/i)).toBeInTheDocument();
  });

  it("refreshes invoices and import history after a successful sync", async () => {
    vi.spyOn(apiClient, "login").mockResolvedValue({ token: "jwt-token" });
    vi.spyOn(apiClient, "fetchCategories").mockResolvedValue({ categories: [] });
    const fetchInvoices = vi.spyOn(apiClient, "fetchInvoices").mockResolvedValue({ invoices: [] });
    vi.spyOn(apiClient, "fetchSyncRuns").mockResolvedValue({ runs: [] });
    vi.spyOn(apiClient, "triggerSync").mockResolvedValue({ invoiceCount: 1 });
    const user = userEvent.setup();

    render(<App />);
    await logIn(user);
    await screen.findByText(/no invoices yet/i);
    await user.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByText(/no imports yet/i);

    fetchInvoices.mockResolvedValue({ invoices: [SAMPLE_INVOICE] });
    await user.click(screen.getByRole("button", { name: /import invoices/i }));

    await vi.waitFor(() => expect(fetchInvoices).toHaveBeenCalledTimes(2));
  });
});
