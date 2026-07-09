import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCategory,
  getCategoryById,
  getCategoryByName,
  listCategories,
} from "./categories.js";
import type { Db } from "./client.js";
import { createDb } from "./client.js";

describe("categories repository", () => {
  let db: Db;
  let close: () => void;

  beforeEach(() => {
    const opened = createDb(":memory:");
    db = opened.db;
    close = () => opened.sqlite.close();
  });

  afterEach(() => close());

  it("creates and reads back a category by name and id", async () => {
    const created = await createCategory(db, "Media");

    expect(created.name).toBe("Media");
    expect(created.id).toBeTypeOf("number");

    const byName = await getCategoryByName(db, "Media");
    const byId = await getCategoryById(db, created.id);

    expect(byName).toEqual(created);
    expect(byId).toEqual(created);
  });

  it("lists all created categories", async () => {
    await createCategory(db, "Media");
    await createCategory(db, "Zakup towarów");
    await createCategory(db, "Inne");

    const all = await listCategories(db);

    expect(all.map((c) => c.name).sort()).toEqual(["Inne", "Media", "Zakup towarów"]);
  });

  it("returns undefined for a category that doesn't exist", async () => {
    expect(await getCategoryByName(db, "Nonexistent")).toBeUndefined();
    expect(await getCategoryById(db, 999)).toBeUndefined();
  });
});
