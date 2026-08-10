import { KsefApiError, KsefRateLimitError } from "ksef-client";

const MAX_MESSAGE_LENGTH = 1000;

export interface SafeKsefErrorDiagnostics {
  message: string;
  errorType: string;
  errorCode: string | null;
  httpStatus: number | null;
  retryAfterSeconds: number | null;
  causeChain: string[];
}

function bounded(value: string): string {
  const redacted = value
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(
      /(authorization|accessToken|refreshToken|KSEF_TOKEN|JWT_SECRET|token)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    );
  return redacted.length <= MAX_MESSAGE_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

function errorCodeFromProblem(problem: unknown): string | null {
  if (!problem || typeof problem !== "object") {
    return null;
  }
  const record = problem as Record<string, unknown>;
  const directCode = record.code ?? record.exceptionCode;
  if (typeof directCode === "string" || typeof directCode === "number") {
    return String(directCode);
  }
  const status = record.status;
  if (status && typeof status === "object") {
    const statusCode = (status as Record<string, unknown>).code;
    if (typeof statusCode === "string" || typeof statusCode === "number") {
      return String(statusCode);
    }
  }
  return null;
}

function safeCauseChain(error: unknown): string[] {
  const chain: string[] = [];
  let current = error instanceof Error ? error.cause : undefined;
  while (current instanceof Error && chain.length < 5) {
    chain.push(bounded(`${current.name}: ${current.message}`));
    current = current.cause;
  }
  return chain;
}

/**
 * Formats an error for a manual/CLI script's top-level catch handler.
 * `KsefRateLimitError` (HTTP 429) gets a clear, human-readable message
 * instead of a raw stack trace -- the KSeF API's export-start endpoint is
 * a POST and isn't covered by the SDK's built-in idempotent-method 429
 * auto-retry, so scripts hitting it need to surface `retryAfterSeconds`
 * themselves. This is informational only; it does not retry or otherwise
 * work around the rate limit -- KSeF's server-side quota must be respected.
 */
export function formatKsefError(error: unknown): string {
  if (error instanceof KsefRateLimitError) {
    const seconds = error.retryAfterSeconds;
    const humanized =
      typeof seconds === "number"
        ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
        : "an unknown amount of time";
    return `KSeF rate limit exceeded (429). Retry after ${humanized} (retryAfterSeconds=${seconds ?? "?"}). Do not retry sooner -- this is a server-side quota, not something the client can bypass.`;
  }
  return bounded(error instanceof Error ? error.message : String(error));
}

/**
 * Extracts only bounded, non-payload diagnostics. In particular, this never
 * copies `responseBody`, headers, tokens, or arbitrary SDK error properties.
 */
export function classifyKsefError(error: unknown): SafeKsefErrorDiagnostics {
  return {
    message: formatKsefError(error),
    errorType: error instanceof Error ? error.name : typeof error,
    errorCode: error instanceof KsefApiError ? errorCodeFromProblem(error.problem) : null,
    httpStatus: error instanceof KsefApiError ? error.statusCode : null,
    retryAfterSeconds:
      error instanceof KsefRateLimitError ? (error.retryAfterSeconds ?? null) : null,
    causeChain: safeCauseChain(error),
  };
}
