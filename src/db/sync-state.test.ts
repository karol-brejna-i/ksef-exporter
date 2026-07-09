import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import { createDb } from "./client.js";
import { getContinuationPoint, setContinuationPoint } from "./sync-state.js";

describe("sync state repository", () => {
  let db: Db;
  let close: () => void;

  beforeEach(() => {
    const opened = createDb(":memory:");
    db = opened.db;
    close = () => opened.sqlite.close();
  });

  afterEach(() => close());

  it("returns undefined for a subject type that has never been synced", async () => {
    expect(await getContinuationPoint(db, "Subject2")).toBeUndefined();
  });

  it("persists and retrieves a continuation point", async () => {
    await setContinuationPoint(db, "Subject2", "2025-01-15T00:00:00Z");

    expect(await getContinuationPoint(db, "Subject2")).toBe("2025-01-15T00:00:00Z");
  });

  it("overwrites the continuation point on subsequent syncs (upsert)", async () => {
    await setContinuationPoint(db, "Subject2", "2025-01-15T00:00:00Z");
    await setContinuationPoint(db, "Subject2", "2025-02-01T00:00:00Z");

    expect(await getContinuationPoint(db, "Subject2")).toBe("2025-02-01T00:00:00Z");
  });

  it("tracks continuation points independently per subject type", async () => {
    await setContinuationPoint(db, "Subject2", "2025-01-15T00:00:00Z");
    await setContinuationPoint(db, "Subject3", "2025-01-20T00:00:00Z");

    expect(await getContinuationPoint(db, "Subject2")).toBe("2025-01-15T00:00:00Z");
    expect(await getContinuationPoint(db, "Subject3")).toBe("2025-01-20T00:00:00Z");
  });

  it("can explicitly store a null continuation point", async () => {
    await setContinuationPoint(db, "Subject2", null);

    expect(await getContinuationPoint(db, "Subject2")).toBeNull();
  });
});
