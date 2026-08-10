import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../api/client";
import { RecentImports } from "./RecentImports";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RecentImports", () => {
  it("shows a loading state while the history is being fetched", () => {
    vi.spyOn(apiClient, "fetchSyncRuns").mockReturnValue(new Promise(() => {}));

    render(<RecentImports token="jwt-token" refreshKey={0} />);

    expect(screen.getByText(/loading import history/i)).toBeInTheDocument();
  });

  it("shows an empty-state message when there are no imports yet", async () => {
    vi.spyOn(apiClient, "fetchSyncRuns").mockResolvedValue({ runs: [] });

    render(<RecentImports token="jwt-token" refreshKey={0} />);

    expect(await screen.findByText(/no imports yet/i)).toBeInTheDocument();
  });

  it("renders a row per run with its outcome", async () => {
    vi.spyOn(apiClient, "fetchSyncRuns").mockResolvedValue({
      runs: [
        {
          id: 1,
          requestedAt: "2025-01-16T10:00:00.000Z",
          startedAt: "2025-01-16T10:00:00.000Z",
          completedAt: "2025-01-16T10:00:02.500Z",
          durationMs: 2500,
          windowFrom: "2025-01-01",
          windowTo: "2025-01-31",
          status: "success",
          invoiceCount: 5,
          errorMessage: null,
          continuationBefore: null,
          continuationAfter: "2025-01-31T00:00:00.000Z",
          fetchedCount: 5,
          insertedCount: 4,
          duplicateCount: 1,
          categorizedCount: 3,
          needsReviewCount: 2,
          hasMore: false,
          maxIterations: 1,
          errorType: null,
          errorCode: null,
          httpStatus: null,
          retryAfterSeconds: null,
        },
        {
          id: 2,
          requestedAt: "2025-02-16T10:00:00.000Z",
          startedAt: "2025-02-16T10:00:00.000Z",
          completedAt: "2025-02-16T10:00:01.000Z",
          durationMs: 1000,
          windowFrom: "2025-02-01",
          windowTo: "2025-02-28",
          status: "error",
          invoiceCount: null,
          errorMessage: "rate limited, retry after 52m",
          continuationBefore: "2025-01-31T00:00:00.000Z",
          continuationAfter: null,
          fetchedCount: null,
          insertedCount: null,
          duplicateCount: null,
          categorizedCount: null,
          needsReviewCount: null,
          hasMore: null,
          maxIterations: 1,
          errorType: "KsefRateLimitError",
          errorCode: "21159",
          httpStatus: 429,
          retryAfterSeconds: 3120,
        },
        {
          id: 3,
          requestedAt: "2025-03-16T10:00:00.000Z",
          startedAt: "2025-03-16T10:00:00.000Z",
          completedAt: null,
          durationMs: null,
          windowFrom: "2025-03-01",
          windowTo: "2025-03-31",
          status: "running",
          invoiceCount: null,
          errorMessage: null,
          continuationBefore: null,
          continuationAfter: null,
          fetchedCount: null,
          insertedCount: null,
          duplicateCount: null,
          categorizedCount: null,
          needsReviewCount: null,
          hasMore: null,
          maxIterations: 1,
          errorType: null,
          errorCode: null,
          httpStatus: null,
          retryAfterSeconds: null,
        },
      ],
    });

    render(<RecentImports token="jwt-token" refreshKey={0} />);

    expect(await screen.findByText("5 invoice(s)")).toBeInTheDocument();
    expect(screen.getByText("Failed: rate limited, retry after 52m")).toBeInTheDocument();
    expect(screen.getByText("2.5s")).toBeInTheDocument();
    expect(screen.getByText("KsefRateLimitError")).toBeInTheDocument();
    expect(screen.getByText("21159")).toBeInTheDocument();
    expect(screen.getByText("3120 seconds")).toBeInTheDocument();
    expect(screen.getByText("In progress…")).toBeInTheDocument();
    expect(screen.getAllByText("Not completed")).toHaveLength(2);
  });

  it("shows an error message when the history fails to load", async () => {
    vi.spyOn(apiClient, "fetchSyncRuns").mockRejectedValue(
      new apiClient.ApiError("unauthorized", 401),
    );

    render(<RecentImports token="jwt-token" refreshKey={0} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("unauthorized");
  });

  it("refetches when refreshKey changes", async () => {
    const spy = vi.spyOn(apiClient, "fetchSyncRuns").mockResolvedValue({ runs: [] });

    const { rerender } = render(<RecentImports token="jwt-token" refreshKey={0} />);
    await screen.findByText(/no imports yet/i);
    expect(spy).toHaveBeenCalledTimes(1);

    rerender(<RecentImports token="jwt-token" refreshKey={1} />);

    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});
