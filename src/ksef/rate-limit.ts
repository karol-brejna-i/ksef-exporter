import { KsefRateLimitError } from "ksef-client";

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
  return error instanceof Error ? error.message : String(error);
}
