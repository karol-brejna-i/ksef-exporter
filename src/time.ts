/**
 * The single owner of temporal semantics for this codebase
 * (design/SCHEMA_TYPES_PLAN.md §3.4).
 *
 * Three kinds of value live in this schema and only look alike:
 *
 * 1. **Civil date** — a calendar day, no time, no zone (`issue_date`,
 *    `window_from`). It has no instant; converting one invents a timezone.
 * 2. **Instant** — a moment in time, stored as epoch milliseconds.
 * 3. **Opaque KSeF token** — the `PermanentStorage` continuation point. It
 *    looks like an instant but must round-trip to KSeF byte-identically, so it
 *    is stored verbatim and only ever *parsed* here to make a decision.
 *
 * Nothing outside this module may compare temporal values as strings. ISO-8601
 * string order is not chronological once offsets differ, and an instant always
 * sorts above a bare date sharing its prefix — the two facts behind the defects
 * catalogued in §1 of the plan.
 */

/** A calendar day in `YYYY-MM-DD` form, verified to be a real date. */
export type IsoDate = string & { readonly __brand: "IsoDate" };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * KSeF continuation points carry microseconds and an explicit offset; the ECMA
 * Date Time String Format only defines three fraction digits, so we parse the
 * shape ourselves rather than trusting `Date.parse` to tolerate the extras.
 */
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

const MS_PER_DAY = 86_400_000;

export function isIsoDate(value: string): value is IsoDate {
  const match = ISO_DATE.exec(value);
  if (match === null) return false;

  const [, year, month, day] = match;
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(ms)) return false;

  // Date.UTC silently rolls 2026-02-30 forward to 2026-03-02; round-tripping
  // the components is what rejects it.
  const parsed = new Date(ms);
  return (
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() === Number(month) - 1 &&
    parsed.getUTCDate() === Number(day)
  );
}

export function assertIsoDate(value: string): IsoDate {
  if (!isIsoDate(value)) {
    throw new TypeError(`Not a calendar date in YYYY-MM-DD form: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Parses a KSeF `PermanentStorage` continuation point to epoch milliseconds.
 *
 * A zone designator is required: without one the value would be read as local
 * time, which is exactly the class of bug this module exists to prevent.
 * Sub-millisecond digits are truncated, matching SQLite's own conversion.
 */
export function continuationPointToEpochMs(point: string): number {
  const match = INSTANT.exec(point);
  if (match === null) {
    throw new TypeError(`Not an ISO-8601 instant with an explicit zone: ${JSON.stringify(point)}`);
  }

  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  const milliseconds = fraction === undefined ? 0 : Number(fraction.slice(0, 3).padEnd(3, "0"));

  const utc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    milliseconds,
  );

  if (zone === undefined || zone === "Z") return utc;

  const offsetMinutes = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6));
  return zone.startsWith("+") ? utc - offsetMinutes * 60_000 : utc + offsetMinutes * 60_000;
}

/** The inclusive start-of-day UTC instant of a civil date. */
export function dateStartMs(date: IsoDate): number {
  const [year, month, day] = date.split("-");
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

/**
 * The **exclusive** end instant of a civil date: start-of-day of the next day.
 *
 * `windowTo` is an inclusive calendar day, so an instant belongs to the window
 * when it is `< dateEndExclusiveMs(windowTo)`. Comparing against `windowTo`
 * itself drops every instant on the final day.
 */
export function dateEndExclusiveMs(date: IsoDate): number {
  return dateStartMs(date) + MS_PER_DAY;
}
