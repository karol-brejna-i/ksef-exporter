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

export type CategorizationConfidence = "matched" | "needs_review" | "not_applicable";

/** "purchase" (KSeF Subject2, tenant is the buyer) or "sales" (Subject1, tenant is the seller). */
export type InvoiceDirection = "purchase" | "sales";

export interface Invoice {
  id: number;
  source: "ksef" | "manual";
  direction: InvoiceDirection;
  ksefNumber: string | null;
  invoiceNumber: string;
  sellerNip: string | null;
  sellerName: string;
  buyerNip: string | null;
  buyerName: string | null;
  issueDate: string;
  grossTotal: number;
  /** Sum of Fa/P_13_1..11; null on manual entries and invoices with no parseable breakdown. */
  netTotal: number | null;
  /** Sum of Fa/P_14_1..5 (excluding the PLN-equivalent *W suffix); null on manual entries and invoices with no parseable breakdown. */
  vatTotal: number | null;
  currency: string;
  /** Fa/Platnosc/TerminPlatnosci/Termin, a civil date (YYYY-MM-DD); null when absent. */
  paymentDueDate: string | null;
  categoryId: number | null;
  categorizationConfidence: CategorizationConfidence;
  createdAt: string; // ISO-8601 UTC instant (YYYY-MM-DDTHH:MM:SS.sssZ)
  itemCount: number;
  itemsExtractedAt: string | null; // ISO-8601 UTC instant (YYYY-MM-DDTHH:MM:SS.sssZ)
}

export interface InvoiceItem {
  ordinal: number;
  lineNumber: number | null;
  uuId: string | null;
  deliveryDate: string | null;
  name: string | null;
  indexCode: string | null;
  gtin: string | null;
  pkwiu: string | null;
  cn: string | null;
  pkob: string | null;
  unit: string | null;
  quantity: number | null;
  unitPriceNet: number | null;
  unitPriceGross: number | null;
  discount: number | null;
  netValue: number | null;
  grossValue: number | null;
  vatValue: number | null;
  vatRate: string | null;
  vatRateOss: number | null;
  annex15: boolean | null;
  excise: number | null;
  gtuCode: string | null;
  procedureCode: string | null;
  exchangeRate: number | null;
  correctionStateBefore: boolean | null;
}

export type SyncRunStatus = "running" | "success" | "error";

export interface SyncRun {
  id: number;
  requestedAt: string; // ISO-8601 UTC instant (YYYY-MM-DDTHH:MM:SS.sssZ)
  startedAt: string | null; // ISO-8601 UTC instant (YYYY-MM-DDTHH:MM:SS.sssZ)
  completedAt: string | null; // ISO-8601 UTC instant (YYYY-MM-DDTHH:MM:SS.sssZ)
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
  itemsInsertedCount: number | null;
  itemsFailedCount: number | null;
  /** KSeF subject type the run synced; null on rows predating sales ingestion. */
  subjectType: "Subject1" | "Subject2" | null;
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

export function fetchInvoices(
  token: string,
  direction?: InvoiceDirection,
): Promise<{ invoices: Invoice[] }> {
  const query = direction ? `?direction=${direction}` : "";
  return request(`/invoices${query}`, {}, token);
}

export function fetchCategories(token: string): Promise<{ categories: Category[] }> {
  return request("/categories", {}, token);
}

export function triggerSync(
  token: string,
  windowFrom: string,
  windowTo: string,
  direction: InvoiceDirection = "purchase",
): Promise<{ syncRunId: number; invoiceCount: number; hasMore?: boolean }> {
  return request(
    "/sync",
    { method: "POST", body: JSON.stringify({ windowFrom, windowTo, direction }) },
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

export function fetchInvoiceItems(
  token: string,
  invoiceId: number,
): Promise<{ items: InvoiceItem[] }> {
  return request(`/invoices/${invoiceId}/items`, {}, token);
}
