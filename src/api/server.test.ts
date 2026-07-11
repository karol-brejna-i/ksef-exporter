import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCategory } from "../db/categories.js";
import type { Db } from "../db/client.js";
import { createDb } from "../db/client.js";
import { insertKsefInvoiceIfNotExists, updateInvoiceCategory } from "../db/invoices.js";
import type { SyncPurchaseInvoicesResult } from "../sync.js";
import { buildServer } from "./server.js";

const config = {
  AUTH_USERNAME: "owner",
  AUTH_PASSWORD: "a-strong-password",
  JWT_SECRET: "a".repeat(32),
  WEB_ORIGIN: "http://localhost:5173",
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
    sync = vi.fn(async (): Promise<SyncPurchaseInvoicesResult> => ({ invoices: [] }));
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
    it("invokes the injected sync function and returns the invoice count", async () => {
      sync.mockResolvedValueOnce({
        invoices: [{ id: 1 }, { id: 2 }],
      } as unknown as SyncPurchaseInvoicesResult);
      const token = await login();

      const response = await fastify.inject({
        method: "POST",
        url: "/sync",
        headers: { authorization: `Bearer ${token}` },
        payload: { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ invoiceCount: 2 });
      expect(sync).toHaveBeenCalledWith(
        db,
        { workflows: {} },
        {
          windowFrom: "2025-01-01",
          windowTo: "2025-01-31",
        },
      );
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
