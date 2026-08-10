export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface Category {
  id: number;
  name: string;
}

export type CategorizationConfidence = "matched" | "needs_review";

export interface Invoice {
  id: number;
  source: "ksef" | "manual";
  ksefNumber: string | null;
  invoiceNumber: string;
  sellerNip: string | null;
  sellerName: string;
  buyerNip: string | null;
  buyerName: string | null;
  issueDate: string;
  grossTotal: number;
  currency: string;
  categoryId: number | null;
  categorizationConfidence: CategorizationConfidence;
  createdAt: string;
}

export type SyncRunStatus = "running" | "success" | "error";

export interface SyncRun {
  id: number;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  windowFrom: string;
  windowTo: string;
  status: SyncRunStatus;
  invoiceCount: number | null;
  errorMessage: string | null;
  continuationBefore: string | null;
  continuationAfter: string | null;
  fetchedCount: number | null;
  insertedCount: number | null;
  duplicateCount: number | null;
  categorizedCount: number | null;
  needsReviewCount: number | null;
  hasMore: boolean | null;
  maxIterations: number | null;
  errorType: string | null;
  errorCode: string | null;
  httpStatus: number | null;
  retryAfterSeconds: number | null;
}

/**
 * Requests go through the `/api` prefix, proxied to the backend by Vite in
 * dev (see vite.config.ts) so the app only ever talks to a single origin.
 */
async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`/api${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = typeof body?.error === "string" ? body.error : "Request failed";
    throw new ApiError(message, response.status);
  }

  return body as T;
}

export function login(username: string, password: string): Promise<{ token: string }> {
  return request("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function fetchInvoices(token: string): Promise<{ invoices: Invoice[] }> {
  return request("/invoices", {}, token);
}

export function fetchCategories(token: string): Promise<{ categories: Category[] }> {
  return request("/categories", {}, token);
}

export function triggerSync(
  token: string,
  windowFrom: string,
  windowTo: string,
): Promise<{ syncRunId: number; invoiceCount: number; hasMore?: boolean }> {
  return request(
    "/sync",
    { method: "POST", body: JSON.stringify({ windowFrom, windowTo }) },
    token,
  );
}

export function correctCategory(
  token: string,
  invoiceId: number,
  categoryId: number,
): Promise<{ invoice: Invoice }> {
  return request(
    `/invoices/${invoiceId}/category`,
    { method: "PATCH", body: JSON.stringify({ categoryId }) },
    token,
  );
}

export function fetchSyncRuns(token: string): Promise<{ runs: SyncRun[] }> {
  return request("/sync/runs", {}, token);
}
