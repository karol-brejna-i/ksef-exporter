import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import { KsefRateLimitError, KsefValidationError } from "ksef-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCategory } from "../db/categories.js";
import type { Db } from "../db/client.js";
import { createDb } from "../db/client.js";
import { replaceInvoiceItems } from "../db/invoice-items.js";
import { insertKsefInvoiceIfNotExists, updateInvoiceCategory } from "../db/invoices.js";
import type { SyncPurchaseInvoicesResult, syncPurchaseInvoices } from "../sync.js";
import { buildServer } from "./server.js";

const config = {
  AUTH_USERNAME: "owner",
  AUTH_PASSWORD: "a-strong-password",
  JWT_SECRET: "a".repeat(32),
  WEB_ORIGIN: "http://localhost:5173",
  // "silent" keeps test output clean; production defaults to "info" (see
  // src/config/env.ts).
  LOG_LEVEL: "silent" as const,
};

const SAMPLE_INVOICE = {
  ksefNumber: "5265877635-20250115-123456789012-01",
  invoiceNumber: "FV/2025/01/001",
  sellerNip: "5265877635",
  sellerName: "Energa Operator",
  buyerNip: "1111111111",
  buyerName: "Parkowa Sp. z o.o.",
  issueDate: "2025-01-15",
  grossTotal: 1234.56,
  currency: "PLN",
  rawXml: "<Faktura></Faktura>",
};

const EMPTY_DIAGNOSTICS: SyncPurchaseInvoicesResult["diagnostics"] = {
  continuationBefore: null,
  continuationAfter: "2025-01-31",
  fetchedCount: 0,
  insertedCount: 0,
  duplicateCount: 0,
  categorizedCount: 0,
  needsReviewCount: 0,
  itemsInsertedCount: 0,
  itemsFailedCount: 0,
  maxIterations: 1,
};

describe("API server", () => {
  let db: Db;
  let close: () => void;
  let fastify: FastifyInstance;
  let getClient: () => Promise<never>;
  let sync: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const opened = createDb(":memory:");
    db = opened.db;
    close = () => opened.sqlite.close();
    // syncPurchaseInvoices is itself mocked below, so the client it would be
    // called with never needs to satisfy the real KsefClient shape.
    getClient = vi.fn(async () => ({ workflows: {} }) as never);
    sync = vi.fn(
      async (): Promise<SyncPurchaseInvoicesResult> => ({
        invoices: [],
        hasMore: false,
        diagnostics: EMPTY_DIAGNOSTICS,
      }),
    );
    fastify = buildServer({ db, config, getClient, sync });
  });

  afterEach(() => {
    close();
  });

  async function login(): Promise<string> {
    const response = await fastify.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "owner", password: "a-strong-password" },
    });
    return (response.json() as { token: string }).token;
  }

  describe("POST /auth/login", () => {
    it("returns a JWT for valid credentials", async () => {
      const response = await fastify.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: "owner", password: "a-strong-password" },
      });

      expect(response.statusCode).toBe(200);
      expect(typeof response.json().token).toBe("string");
    });

    it("rejects invalid credentials with 401", async () => {
      const response = await fastify.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: "owner", password: "wrong" },
      });

      expect(response.statusCode).toBe(401);
    });

    it("rejects a missing password with 400", async () => {
      const response = await fastify.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: "owner" },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("protected routes", () => {
    it("rejects GET /invoices without a token", async () => {
      const response = await fastify.inject({ method: "GET", url: "/invoices" });

      expect(response.statusCode).toBe(401);
    });

    it("rejects POST /sync without a token", async () => {
      const response = await fastify.inject({
        method: "POST",
        url: "/sync",
        payload: { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      });

      expect(response.statusCode).toBe(401);
    });

    it("rejects a request with a malformed token", async () => {
      const response = await fastify.inject({
        method: "GET",
        url: "/invoices",
        headers: { authorization: "Bearer not-a-real-token" },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe("GET /invoices", () => {
    it("returns invoices for an authenticated request", async () => {
      await insertKsefInvoiceIfNotExists(db, SAMPLE_INVOICE);
      const token = await login();

      const response = await fastify.inject({
        method: "GET",
        url: "/invoices",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { invoices: Array<{ ksefNumber: string }> };
      expect(body.invoices).toHaveLength(1);
      expect(body.invoices[0]?.ksefNumber).toBe(SAMPLE_INVOICE.ksefNumber);
    });

    it("filters by month and categoryId query params", async () => {
      const category = await createCategory(db, "Media");
      const inserted = await insertKsefInvoiceIfNotExists(db, SAMPLE_INVOICE);
      await updateInvoiceCategory(db, inserted.id, category.id, "matched");
      const token = await login();

      const response = await fastify.inject({
        method: "GET",
        url: `/invoices?month=2025-01&categoryId=${category.id}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect((response.json() as { invoices: unknown[] }).invoices).toHaveLength(1);
    });

    it("rejects a malformed month query param with 400", async () => {
      const token = await login();

      const response = await fastify.inject({
        method: "GET",
        url: "/invoices?month=not-a-month",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(400);
    });

    it("includes itemCount for each invoice", async () => {
      const invoice = await insertKsefInvoiceIfNotExists(db, SAMPLE_INVOICE);
      replaceInvoiceItems(db, invoice.id, [
        { invoiceId: invoice.id, ordinal: 1, lineNumber: 1, name: "Item 1" },
        { invoiceId: invoice.id, ordinal: 2, lineNumber: 2, name: "Item 2" },
      ]);
      const token = await login();

      const response = await fastify.inject({
        method: "GET",
        url: "/invoices",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { invoices: Array<{ itemCount: number }> };
      expect(body.invoices[0]?.itemCount).toBe(2);
    });

    it("includes itemCount as 0 for an invoice with no items", async () => {
      await insertKsefInvoiceIfNotExists(db, SAMPLE_INVOICE);
      const token = await login();

      const response = await fastify.inject({
        method: "GET",
        url: "/invoices",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { invoices: Array<{ itemCount: number }> };
      expect(body.invoices[0]?.itemCount).toBe(0);
    });

    it("includes itemsExtractedAt", async () => {
      const invoice = await insertKsefInvoiceIfNotExists(db, SAMPLE_INVOICE);
      replaceInvoiceItems(db, invoice.id, [
        { invoiceId: invoice.id, ordinal: 1, lineNumber: 1, name: "Item 1" },
      ]);
      const token = await login();

      const response = await fastify.inject({
        method: "GET",
        url: "/invoices",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        invoices: Array<{ itemsExtractedAt: string | null }>;
      };
      expect(body.invoices[0]?.itemsExtractedAt).not.toBeNull();
      expect(typeof body.invoices[0]?.itemsExtractedAt).toBe("string");
    });

    it("includes itemsExtractedAt as null when items not extracted", async () => {
      await insertKsefInvoiceIfNotExists(db, SAMPLE_INVOICE);
      const token = await login();

      const response = await fastify.inject({
        method: "GET",
        url: "/invoices",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        invoices: Array<{ itemsExtractedAt: string | null }>;
      };
      expect(body.invoices[0]?.itemsExtractedAt).toBeNull();
    });
  });

  describe("GET /invoices/:id/items", () => {
    it("returns items ordered by ordinal", async () => {
      const invoice = await insertKsefInvoiceIfNotExists(db, SAMPLE_INVOICE);
      replaceInvoiceItems(db, invoice.id, [
        { invoiceId: invoice.id, ordinal: 2, lineNumber: 2, name: "Second item" },
        { invoiceId: invoice.id, ordinal: 1, lineNumber: 1, name: "First item" },
        { invoiceId: invoice.id, ordinal: 3, lineNumber: 3, name: "Third item" },
      ]);
      const token = await login();

      const response = await fastify.inject({
        method: "GET",
        url: `/invoices/${invoice.id}/items`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { items: Array<{ ordinal: number; name: string | null }> };
      expect(body.items).toHaveLength(3);
      expect(body.items.map((item) => item.ordinal)).toEqual([1, 2, 3]);
      expect(body.items.map((item) => item.name)).toEqual([
        "First item",
        "Second item",
        "Third item",
      ]);
    });

    it("returns empty array for an invoice with no items", async () => {
      const invoice = await insertKsefInvoiceIfNotExists(db, SAMPLE_INVOICE);
      replaceInvoiceItems(db, invoice.id, []);
      const token = await login();

      const response = await fastify.inject({
        method: "GET",
        url: `/invoices/${invoice.id}/items`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ items: [] });
    });

    it("returns 404 for a non-existent invoice", async () => {
      const token = await login();

      const response = await fastify.inject({
        method: "GET",
        url: "/invoices/999/items",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it("rejects a request without a token", async () => {
      const response = await fastify.inject({
        method: "GET",
        url: "/invoices/1/items",
      });

      expect(response.statusCode).toBe(401);
    });

    it("rejects a non-numeric invoice id with 400", async () => {
      const token = await login();

      const response = await fastify.inject({
        method: "GET",
        url: "/invoices/not-a-number/items",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("GET /categories", () => {
    it("returns categories for an authenticated request", async () => {
      await createCategory(db, "Media");
      const token = await login();

      const response = await fastify.inject({
        method: "GET",
        url: "/categories",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { categories: Array<{ name: string }> };
      expect(body.categories.map((c) => c.name)).toEqual(["Media"]);
    });

    it("rejects a request without a token", async () => {
      const response = await fastify.inject({ method: "GET", url: "/categories" });

      expect(response.statusCode).toBe(401);
    });
  });

  describe("POST /sync", () => {
    it("writes correlated structured lifecycle events", async () => {
      const logStream = new PassThrough();
      let output = "";
      logStream.on("data", (chunk) => {
        output += chunk.toString();
      });
      const observableSync = vi.fn(async (...args: Parameters<typeof syncPurchaseInvoices>) => {
        args[3]?.logger?.info("sync.fetch.started", { maxIterations: 1 });
        args[3]?.logger?.info("sync.fetch.completed", { fetchedCount: 0 });
        args[3]?.logger?.info("sync.persist.started", { fetchedCount: 0 });
        args[3]?.logger?.info("sync.persist.completed", { insertedCount: 0 });
        return { invoices: [], hasMore: false, diagnostics: EMPTY_DIAGNOSTICS };
      });
      const observableServer = buildServer({
        db,
        config: { ...config, LOG_LEVEL: "info" },
        getClient,
        sync: observableSync,
        logStream,
      });
      const loginResponse = await observableServer.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: "owner", password: "a-strong-password" },
      });
      const token = (loginResponse.json() as { token: string }).token;

      await observableServer.inject({
        method: "POST",
        url: "/sync",
        headers: { authorization: `Bearer ${token}` },
        payload: { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      });
      observableSync.mockRejectedValueOnce(new Error("safe failure"));
      await observableServer.inject({
        method: "POST",
        url: "/sync",
        headers: { authorization: `Bearer ${token}` },
        payload: { windowFrom: "2025-02-01", windowTo: "2025-02-28" },
      });

      const lifecycle = output
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event?: string; syncRunId?: number; stage?: string })
        .filter((entry) => entry.event?.startsWith("sync."));
      expect(lifecycle.slice(0, 8).map((entry) => entry.event)).toEqual([
        "sync.started",
        "sync.client.started",
        "sync.client.completed",
        "sync.fetch.started",
        "sync.fetch.completed",
        "sync.persist.started",
        "sync.persist.completed",
        "sync.completed",
      ]);
      expect(new Set(lifecycle.slice(0, 8).map((entry) => entry.syncRunId))).toEqual(new Set([1]));
      expect(lifecycle.slice(8).map((entry) => entry.event)).toEqual([
        "sync.started",
        "sync.client.started",
        "sync.client.completed",
        "sync.failed",
      ]);
      expect(new Set(lifecycle.slice(8).map((entry) => entry.syncRunId))).toEqual(new Set([2]));
      // The second run failed right after the client stage, before any fetch.
      expect(lifecycle.at(-1)).toMatchObject({ event: "sync.failed", stage: "client" });
    });

    it("invokes the injected sync function and returns the invoice count", async () => {
      sync.mockResolvedValueOnce({
        invoices: [{ id: 1 }, { id: 2 }],
        hasMore: false,
        diagnostics: { ...EMPTY_DIAGNOSTICS, fetchedCount: 2, insertedCount: 2 },
      } as unknown as SyncPurchaseInvoicesResult);
      const token = await login();

      const response = await fastify.inject({
        method: "POST",
        url: "/sync",
        headers: { authorization: `Bearer ${token}` },
        payload: { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ syncRunId: 1, invoiceCount: 2, hasMore: false });
      expect(sync).toHaveBeenCalledWith(
        db,
        { workflows: {} },
        {
          windowFrom: "2025-01-01",
          windowTo: "2025-01-31",
        },
        { logger: { info: expect.any(Function), warn: expect.any(Function) } },
      );
    });

    it("returns hasMore: true when more invoices are likely still available in the window", async () => {
      sync.mockResolvedValueOnce({
        invoices: [{ id: 1 }],
        hasMore: true,
        diagnostics: { ...EMPTY_DIAGNOSTICS, fetchedCount: 1, insertedCount: 1 },
      } as unknown as SyncPurchaseInvoicesResult);
      const token = await login();

      const response = await fastify.inject({
        method: "POST",
        url: "/sync",
        headers: { authorization: `Bearer ${token}` },
        payload: { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      });

      expect(response.json()).toEqual({ syncRunId: 1, invoiceCount: 1, hasMore: true });
    });

    it("rejects a request missing windowFrom/windowTo with 400", async () => {
      const token = await login();

      const response = await fastify.inject({
        method: "POST",
        url: "/sync",
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(getClient).not.toHaveBeenCalled();
    });

    it("records a successful sync run", async () => {
      sync.mockResolvedValueOnce({
        invoices: [{ id: 1 }],
        hasMore: false,
        diagnostics: {
          ...EMPTY_DIAGNOSTICS,
          fetchedCount: 1,
          insertedCount: 1,
          categorizedCount: 1,
        },
      } as unknown as SyncPurchaseInvoicesResult);
      const token = await login();

      await fastify.inject({
        method: "POST",
        url: "/sync",
        headers: { authorization: `Bearer ${token}` },
        payload: { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      });

      const runsResponse = await fastify.inject({
        method: "GET",
        url: "/sync/runs",
        headers: { authorization: `Bearer ${token}` },
      });
      const body = runsResponse.json() as { runs: Array<Record<string, unknown>> };
      expect(body.runs).toHaveLength(1);
      expect(body.runs[0]).toMatchObject({
        windowFrom: "2025-01-01",
        windowTo: "2025-01-31",
        status: "success",
        invoiceCount: 1,
        fetchedCount: 1,
        insertedCount: 1,
        duplicateCount: 0,
        categorizedCount: 1,
        continuationAfter: "2025-01-31",
        maxIterations: 1,
      });
    });

    it("records a failed sync run and still propagates the error", async () => {
      sync.mockRejectedValueOnce(new Error("rate limited, retry after 52m"));
      const token = await login();

      const response = await fastify.inject({
        method: "POST",
        url: "/sync",
        headers: { authorization: `Bearer ${token}` },
        payload: { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      });

      expect(response.statusCode).toBe(500);

      const runsResponse = await fastify.inject({
        method: "GET",
        url: "/sync/runs",
        headers: { authorization: `Bearer ${token}` },
      });
      const body = runsResponse.json() as { runs: Array<Record<string, unknown>> };
      expect(body.runs[0]).toMatchObject({
        status: "error",
        errorMessage: "rate limited, retry after 52m",
        errorType: "Error",
      });
    });

    it("returns a friendly rate-limit message with the KSeF status code and records it on the run", async () => {
      sync.mockRejectedValueOnce(
        new KsefRateLimitError(429, "Rate limit exceeded", null, "180", 180),
      );
      const token = await login();

      const response = await fastify.inject({
        method: "POST",
        url: "/sync",
        headers: { authorization: `Bearer ${token}` },
        payload: { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      });

      expect(response.statusCode).toBe(429);
      expect((response.json() as { error: string }).error).toMatch(/retry after 3m00s/i);

      const runsResponse = await fastify.inject({
        method: "GET",
        url: "/sync/runs",
        headers: { authorization: `Bearer ${token}` },
      });
      const body = runsResponse.json() as { runs: Array<Record<string, unknown>> };
      expect(body.runs[0]?.errorMessage).toMatch(/retry after 3m00s/i);
      expect(body.runs[0]).toMatchObject({
        errorType: "KsefRateLimitError",
        httpStatus: 429,
        retryAfterSeconds: 180,
      });
    });

    it("returns 400 when the SDK rejects the requested window before calling KSeF", async () => {
      sync.mockRejectedValueOnce(
        new KsefValidationError(
          "Invoice query filters.dateRange.to must be greater than or equal to dateRange.from.",
        ),
      );
      const token = await login();

      const response = await fastify.inject({
        method: "POST",
        url: "/sync",
        headers: { authorization: `Bearer ${token}` },
        payload: { windowFrom: "2026-07-01", windowTo: "2026-07-31" },
      });

      expect(response.statusCode).toBe(400);
      expect((response.json() as { error: string }).error).toMatch(/dateRange\.to/);

      const runsResponse = await fastify.inject({
        method: "GET",
        url: "/sync/runs",
        headers: { authorization: `Bearer ${token}` },
      });
      const body = runsResponse.json() as { runs: Array<Record<string, unknown>> };
      expect(body.runs[0]).toMatchObject({
        status: "error",
        errorType: "KsefValidationError",
      });
    });
  });

  describe("GET /sync/runs", () => {
    it("rejects a request without a token", async () => {
      const response = await fastify.inject({ method: "GET", url: "/sync/runs" });

      expect(response.statusCode).toBe(401);
    });

    it("returns an empty list when no imports have been triggered yet", async () => {
      const token = await login();

      const response = await fastify.inject({
        method: "GET",
        url: "/sync/runs",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ runs: [] });
    });
  });

  describe("PATCH /invoices/:id/category", () => {
    it("corrects the category and returns the updated invoice", async () => {
      const category = await createCategory(db, "Media");
      const invoice = await insertKsefInvoiceIfNotExists(db, SAMPLE_INVOICE);
      const token = await login();

      const response = await fastify.inject({
        method: "PATCH",
        url: `/invoices/${invoice.id}/category`,
        headers: { authorization: `Bearer ${token}` },
        payload: { categoryId: category.id },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        invoice: { categoryId: number; categorizationConfidence: string };
      };
      expect(body.invoice.categoryId).toBe(category.id);
      expect(body.invoice.categorizationConfidence).toBe("matched");
    });

    it("rejects a request without a token", async () => {
      const response = await fastify.inject({
        method: "PATCH",
        url: "/invoices/1/category",
        payload: { categoryId: 1 },
      });

      expect(response.statusCode).toBe(401);
    });

    it("rejects a missing categoryId with 400", async () => {
      const invoice = await insertKsefInvoiceIfNotExists(db, SAMPLE_INVOICE);
      const token = await login();

      const response = await fastify.inject({
        method: "PATCH",
        url: `/invoices/${invoice.id}/category`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    it("rejects a non-numeric invoice id with 400", async () => {
      const token = await login();

      const response = await fastify.inject({
        method: "PATCH",
        url: "/invoices/not-a-number/category",
        headers: { authorization: `Bearer ${token}` },
        payload: { categoryId: 1 },
      });

      expect(response.statusCode).toBe(400);
    });

    it("returns 404 for a non-existent invoice", async () => {
      const category = await createCategory(db, "Media");
      const token = await login();

      const response = await fastify.inject({
        method: "PATCH",
        url: "/invoices/999/category",
        headers: { authorization: `Bearer ${token}` },
        payload: { categoryId: category.id },
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
