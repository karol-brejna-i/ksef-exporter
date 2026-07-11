import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ApiError,
  correctCategory,
  fetchCategories,
  fetchInvoices,
  fetchSyncRuns,
  login,
  triggerSync,
} from "./client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetch(status: number, body: unknown): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

describe("api client", () => {
  it("login posts credentials and returns the token", async () => {
    mockFetch(200, { token: "jwt-token" });

    const result = await login("owner", "secret");

    expect(result).toEqual({ token: "jwt-token" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/auth/login",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ username: "owner", password: "secret" }),
      }),
    );
  });

  it("throws ApiError with the server-provided message on failure", async () => {
    mockFetch(401, { error: "invalid credentials" });

    await expect(login("owner", "wrong")).rejects.toMatchObject({
      message: "invalid credentials",
      status: 401,
    } satisfies Partial<ApiError>);
  });

  it("sends the bearer token for authenticated requests", async () => {
    mockFetch(200, { invoices: [] });

    await fetchInvoices("jwt-token");

    const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(new Headers(options.headers).get("authorization")).toBe("Bearer jwt-token");
  });

  it("fetches categories", async () => {
    mockFetch(200, { categories: [{ id: 1, name: "Media" }] });

    const result = await fetchCategories("jwt-token");

    expect(result.categories).toEqual([{ id: 1, name: "Media" }]);
  });

  it("triggers a sync with the given window", async () => {
    mockFetch(200, { invoiceCount: 3 });

    const result = await triggerSync("jwt-token", "2025-01-01", "2025-01-31");

    expect(result).toEqual({ invoiceCount: 3 });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/sync",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ windowFrom: "2025-01-01", windowTo: "2025-01-31" }),
      }),
    );
  });

  it("corrects an invoice's category", async () => {
    const invoice = { id: 1, categoryId: 2, categorizationConfidence: "matched" };
    mockFetch(200, { invoice });

    const result = await correctCategory("jwt-token", 1, 2);

    expect(result).toEqual({ invoice });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/invoices/1/category",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ categoryId: 2 }),
      }),
    );
  });

  it("fetches recent sync runs", async () => {
    const runs = [
      {
        id: 1,
        requestedAt: "2025-01-16T00:00:00.000Z",
        windowFrom: "2025-01-01",
        windowTo: "2025-01-31",
        status: "success",
        invoiceCount: 5,
        errorMessage: null,
      },
    ];
    mockFetch(200, { runs });

    const result = await fetchSyncRuns("jwt-token");

    expect(result).toEqual({ runs });
  });
});
