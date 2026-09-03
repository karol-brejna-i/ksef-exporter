import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../api/client";
import * as downloadBlobModule from "../downloadBlob";
import { ExportButton } from "./ExportButton";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ExportButton", () => {
  it("fetches the export and triggers a download using the entered date range", async () => {
    const blob = new Blob(["x"]);
    vi.spyOn(apiClient, "fetchInvoiceExport").mockResolvedValue({
      blob,
      filename: "invoices-export-all.xlsx",
    });
    const downloadBlobSpy = vi
      .spyOn(downloadBlobModule, "downloadBlob")
      .mockImplementation(() => {});
    const user = userEvent.setup();

    render(<ExportButton token="jwt-token" />);
    const fromInput = screen.getByLabelText("From");
    const toInput = screen.getByLabelText("To");
    await user.type(fromInput, "2025-01-01");
    await user.type(toInput, "2025-03-31");
    await user.click(screen.getByRole("button", { name: /export/i }));

    expect(apiClient.fetchInvoiceExport).toHaveBeenCalledWith(
      "jwt-token",
      "2025-01-01",
      "2025-03-31",
    );
    await vi.waitFor(() =>
      expect(downloadBlobSpy).toHaveBeenCalledWith(blob, "invoices-export-all.xlsx"),
    );
  });

  it("defaults to an unbounded range when no dates are entered", async () => {
    vi.spyOn(apiClient, "fetchInvoiceExport").mockResolvedValue({
      blob: new Blob(["x"]),
      filename: "invoices-export-all.xlsx",
    });
    vi.spyOn(downloadBlobModule, "downloadBlob").mockImplementation(() => {});
    const user = userEvent.setup();

    render(<ExportButton token="jwt-token" />);
    await user.click(screen.getByRole("button", { name: /export/i }));

    expect(apiClient.fetchInvoiceExport).toHaveBeenCalledWith("jwt-token", undefined, undefined);
  });

  it("disables the button and shows Exporting… while the request is in flight", async () => {
    let resolveExport: (value: apiClient.InvoiceExportDownload) => void = () => {};
    vi.spyOn(apiClient, "fetchInvoiceExport").mockReturnValue(
      new Promise((resolve) => {
        resolveExport = resolve;
      }),
    );
    vi.spyOn(downloadBlobModule, "downloadBlob").mockImplementation(() => {});
    const user = userEvent.setup();

    render(<ExportButton token="jwt-token" />);
    const button = screen.getByRole("button", { name: /export/i });
    await user.click(button);

    expect(screen.getByRole("button", { name: /exporting/i })).toBeDisabled();

    resolveExport({ blob: new Blob(["x"]), filename: "invoices-export-all.xlsx" });
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: /export/i })).not.toBeDisabled(),
    );
  });

  it("shows an error alert and does not trigger a download when the export fails", async () => {
    vi.spyOn(apiClient, "fetchInvoiceExport").mockRejectedValue(
      new apiClient.ApiError("No invoices found for the given criteria.", 404),
    );
    const downloadBlobSpy = vi
      .spyOn(downloadBlobModule, "downloadBlob")
      .mockImplementation(() => {});
    const user = userEvent.setup();

    render(<ExportButton token="jwt-token" />);
    await user.click(screen.getByRole("button", { name: /export/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No invoices found for the given criteria.",
    );
    expect(downloadBlobSpy).not.toHaveBeenCalled();
  });
});
