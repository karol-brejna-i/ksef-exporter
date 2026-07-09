import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../api/client";
import { SyncButton } from "./SyncButton";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SyncButton", () => {
  it("triggers a sync for the current month and calls onSynced", async () => {
    vi.spyOn(apiClient, "triggerSync").mockResolvedValue({ invoiceCount: 5 });
    const onSynced = vi.fn();
    const user = userEvent.setup();

    render(<SyncButton token="jwt-token" onSynced={onSynced} />);
    await user.click(screen.getByRole("button", { name: /fetch this month/i }));

    expect(apiClient.triggerSync).toHaveBeenCalledWith(
      "jwt-token",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );
    expect(await screen.findByText("Synced 5 invoice(s).")).toBeInTheDocument();
    expect(onSynced).toHaveBeenCalled();
  });

  it("shows an error message and does not call onSynced when the sync fails", async () => {
    vi.spyOn(apiClient, "triggerSync").mockRejectedValue(
      new apiClient.ApiError("rate limited, retry later", 429),
    );
    const onSynced = vi.fn();
    const user = userEvent.setup();

    render(<SyncButton token="jwt-token" onSynced={onSynced} />);
    await user.click(screen.getByRole("button", { name: /fetch this month/i }));

    expect(await screen.findByText("rate limited, retry later")).toBeInTheDocument();
    expect(onSynced).not.toHaveBeenCalled();
  });
});
