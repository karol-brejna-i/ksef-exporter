import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../api/client";
import { SyncButton } from "./SyncButton";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SyncButton", () => {
  it("defaults to the current month and triggers a sync on click", async () => {
    vi.spyOn(apiClient, "triggerSync").mockResolvedValue({ invoiceCount: 5 });
    const onSynced = vi.fn();
    const user = userEvent.setup();

    render(<SyncButton token="jwt-token" onSynced={onSynced} />);
    await user.click(screen.getByRole("button", { name: /import invoices/i }));

    expect(apiClient.triggerSync).toHaveBeenCalledWith(
      "jwt-token",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );
    expect(await screen.findByText("Synced 5 invoice(s).")).toBeInTheDocument();
    expect(onSynced).toHaveBeenCalled();
  });

  it("triggers a sync using a custom date range entered by the user", async () => {
    vi.spyOn(apiClient, "triggerSync").mockResolvedValue({ invoiceCount: 2 });
    const onSynced = vi.fn();
    const user = userEvent.setup();

    render(<SyncButton token="jwt-token" onSynced={onSynced} />);
    const fromInput = screen.getByLabelText("From");
    const toInput = screen.getByLabelText("To");
    await user.clear(fromInput);
    await user.type(fromInput, "2025-01-01");
    await user.clear(toInput);
    await user.type(toInput, "2025-03-31");
    await user.click(screen.getByRole("button", { name: /import invoices/i }));

    expect(apiClient.triggerSync).toHaveBeenCalledWith("jwt-token", "2025-01-01", "2025-03-31");
    expect(await screen.findByText("Synced 2 invoice(s).")).toBeInTheDocument();
  });

  it("shows an error message and does not call onSynced when the sync fails", async () => {
    vi.spyOn(apiClient, "triggerSync").mockRejectedValue(
      new apiClient.ApiError("rate limited, retry later", 429),
    );
    const onSynced = vi.fn();
    const user = userEvent.setup();

    render(<SyncButton token="jwt-token" onSynced={onSynced} />);
    await user.click(screen.getByRole("button", { name: /import invoices/i }));

    expect(await screen.findByText("rate limited, retry later")).toBeInTheDocument();
    expect(onSynced).not.toHaveBeenCalled();
  });
});
