/**
 * Format an ISO-8601 UTC instant for display in the user's local timezone.
 *
 * @param iso - ISO-8601 UTC instant string (e.g. "2025-01-16T10:00:00.000Z")
 * @returns Human-readable local date-time string
 */
export function formatInstant(iso: string): string {
  return new Date(iso).toLocaleString();
}
