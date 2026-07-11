import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import { createDb } from "./client.js";
import {
  createSyncRun,
  listRecentSyncRuns,
  markSyncRunError,
  markSyncRunSuccess,
} from "./sync-runs.js";

describe("sync-runs repository", () => {
  let db: Db;
  let close: () => void;

  beforeEach(() => {
    const opened = createDb(":memory:");
    db = opened.db;
    close = () => opened.sqlite.close();
  });

  afterEach(() => close());

  it("creates a run in 'running' status", async () => {
    const run = await createSyncRun(db, { windowFrom: "2025-01-01", windowTo: "2025-01-31" });

    expect(run.status).toBe("running");
    expect(run.windowFrom).toBe("2025-01-01");
    expect(run.windowTo).toBe("2025-01-31");
    expect(run.invoiceCount).toBeNull();
    expect(run.errorMessage).toBeNull();
  });

  it("marks a run as successful with an invoice count", async () => {
    const run = await createSyncRun(db, { windowFrom: "2025-01-01", windowTo: "2025-01-31" });

    const updated = await markSyncRunSuccess(db, run.id, 12);

    expect(updated.status).toBe("success");
    expect(updated.invoiceCount).toBe(12);
    expect(updated.errorMessage).toBeNull();
  });

  it("marks a run as failed with an error message", async () => {
    const run = await createSyncRun(db, { windowFrom: "2025-01-01", windowTo: "2025-01-31" });

    const updated = await markSyncRunError(db, run.id, "rate limited, retry after 52m");

    expect(updated.status).toBe("error");
    expect(updated.errorMessage).toBe("rate limited, retry after 52m");
    expect(updated.invoiceCount).toBeNull();
  });

  it("throws when marking a non-existent run", async () => {
    await expect(markSyncRunSuccess(db, 999, 1)).rejects.toThrow();
    await expect(markSyncRunError(db, 999, "boom")).rejects.toThrow();
  });

  it("lists recent runs newest-first, capped at the given limit", async () => {
    for (let i = 0; i < 3; i++) {
      await createSyncRun(db, { windowFrom: `2025-0${i + 1}-01`, windowTo: `2025-0${i + 1}-28` });
    }

    const runs = await listRecentSyncRuns(db, 2);

    expect(runs).toHaveLength(2);
    expect(runs[0]?.windowFrom).toBe("2025-03-01");
    expect(runs[1]?.windowFrom).toBe("2025-02-01");
  });
});
