import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCategory } from "./categories.js";
import type { Db } from "./client.js";
import { createDb } from "./client.js";
import { deleteRule, findRule, listRules, upsertRule } from "./rules.js";

describe("categorization rules repository", () => {
  let db: Db;
  let close: () => void;
  let mediaCategoryId: number;
  let otherCategoryId: number;

  beforeEach(async () => {
    const opened = createDb(":memory:");
    db = opened.db;
    close = () => opened.sqlite.close();
    mediaCategoryId = (await createCategory(db, "Media")).id;
    otherCategoryId = (await createCategory(db, "Inne")).id;
  });

  afterEach(() => close());

  it("creates a rule and finds it by match type/value", async () => {
    const created = await upsertRule(db, {
      matchType: "seller_nip",
      matchValue: "5265877635",
      categoryId: mediaCategoryId,
    });

    expect(created.categoryId).toBe(mediaCategoryId);

    const found = await findRule(db, "seller_nip", "5265877635");
    expect(found).toEqual(created);
  });

  it("updates the category of an existing rule instead of creating a duplicate", async () => {
    await upsertRule(db, {
      matchType: "seller_name_contains",
      matchValue: "Energa",
      categoryId: mediaCategoryId,
    });

    const updated = await upsertRule(db, {
      matchType: "seller_name_contains",
      matchValue: "Energa",
      categoryId: otherCategoryId,
    });

    const all = await listRules(db);
    expect(all).toHaveLength(1);
    expect(updated.categoryId).toBe(otherCategoryId);
  });

  it("lists all rules", async () => {
    await upsertRule(db, {
      matchType: "seller_nip",
      matchValue: "111",
      categoryId: mediaCategoryId,
    });
    await upsertRule(db, {
      matchType: "seller_nip",
      matchValue: "222",
      categoryId: otherCategoryId,
    });

    const all = await listRules(db);
    expect(all).toHaveLength(2);
  });

  it("deletes a rule", async () => {
    const rule = await upsertRule(db, {
      matchType: "seller_nip",
      matchValue: "333",
      categoryId: mediaCategoryId,
    });

    await deleteRule(db, rule.id);

    expect(await findRule(db, "seller_nip", "333")).toBeUndefined();
  });
});
