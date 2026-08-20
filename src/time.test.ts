import { describe, expect, it } from "vitest";
import {
  assertIsoDate,
  continuationPointToEpochMs,
  dateEndExclusiveMs,
  dateStartMs,
  isIsoDate,
} from "./time.js";

describe("isIsoDate", () => {
  it("accepts a real calendar day", () => {
    expect(isIsoDate("2026-08-10")).toBe(true);
    expect(isIsoDate("2024-02-29")).toBe(true);
  });

  it.each([
    ["wrong separator order", "10/08/2026"],
    ["unpadded month and day", "2026-8-10"],
    ["a day that does not exist", "2026-02-30"],
    ["a non-leap 29 February", "2023-02-29"],
    ["month 13", "2026-13-01"],
    ["an instant, not a date", "2026-08-10T00:00:00Z"],
    ["empty", ""],
    ["trailing space", "2026-08-10 "],
  ])("rejects %s", (_label, value) => {
    expect(isIsoDate(value)).toBe(false);
  });
});

describe("assertIsoDate", () => {
  it("returns the branded value", () => {
    expect(assertIsoDate("2026-08-10")).toBe("2026-08-10");
  });

  it("throws on an invalid calendar day", () => {
    expect(() => assertIsoDate("2026-02-30")).toThrow(TypeError);
  });
});

describe("continuationPointToEpochMs", () => {
  // Values pinned from design/SCHEMA_TYPES_PLAN.md §2.4, cross-checked against
  // SQLite 3.53.0. A deviation here is a bug to investigate, not a number to update.
  it.each([
    ["2026-08-12T11:16:15.304Z", 1_786_533_375_304],
    ["2026-08-10T15:32:59.989017+00:00", 1_786_375_979_989],
    ["2026-08-10T15:32:59.989017+02:00", 1_786_368_779_989],
  ])("parses %s to %i", (point, expected) => {
    expect(continuationPointToEpochMs(point)).toBe(expected);
  });

  it("truncates sub-millisecond digits rather than rounding", () => {
    expect(continuationPointToEpochMs("2026-08-10T15:32:59.989999+00:00")).toBe(1_786_375_979_989);
  });

  it("pads short fractions to milliseconds", () => {
    expect(continuationPointToEpochMs("2026-08-10T15:32:59.9Z")).toBe(
      continuationPointToEpochMs("2026-08-10T15:32:59.900Z"),
    );
  });

  it("regression, Defect C: the later-sorting offset is the earlier instant", () => {
    // '+00:00' sorts below '+02:00' because '0' < '2', yet it is two hours later.
    const plusZero = "2026-08-10T15:32:59.989017+00:00";
    const plusTwo = "2026-08-10T15:32:59.989017+02:00";

    expect(plusTwo > plusZero).toBe(true);
    expect(continuationPointToEpochMs(plusTwo)).toBeLessThan(continuationPointToEpochMs(plusZero));
    expect(continuationPointToEpochMs(plusZero) - continuationPointToEpochMs(plusTwo)).toBe(
      7_200_000,
    );
  });

  it("handles negative offsets", () => {
    expect(continuationPointToEpochMs("2026-08-10T13:32:59.989-02:00")).toBe(1_786_375_979_989);
  });

  it.each([
    ["a zone designator is missing", "2026-08-10T15:32:59.989017"],
    ["the legacy space-separated form", "2026-08-10 15:35:01"],
    ["a bare calendar date", "2026-06-30"],
    ["empty", ""],
  ])("throws when %s", (_label, value) => {
    expect(() => continuationPointToEpochMs(value)).toThrow(TypeError);
  });
});

describe("dateStartMs / dateEndExclusiveMs", () => {
  it("pins the §2.4 civil-date value", () => {
    expect(dateStartMs(assertIsoDate("2026-06-30"))).toBe(1_782_777_600_000);
  });

  it("ends a day exactly where the next one starts", () => {
    expect(dateEndExclusiveMs(assertIsoDate("2026-08-31"))).toBe(
      dateStartMs(assertIsoDate("2026-09-01")),
    );
  });

  it("crosses a year boundary", () => {
    expect(dateEndExclusiveMs(assertIsoDate("2026-12-31"))).toBe(
      dateStartMs(assertIsoDate("2027-01-01")),
    );
  });

  it("regression, Defect B: an instant on the final day is inside the window", () => {
    const stored = continuationPointToEpochMs("2026-08-10T15:32:59.989017+00:00");
    const from = dateStartMs(assertIsoDate("2026-08-01"));
    const toExclusive = dateEndExclusiveMs(assertIsoDate("2026-08-10"));

    expect(stored >= from && stored < toExclusive).toBe(true);
    // The string comparison this replaces gets it wrong.
    expect("2026-08-10T15:32:59.989017+00:00" <= "2026-08-10").toBe(false);
  });
});
