import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listCategories } from "../db/categories.js";
import type { Db } from "../db/client.js";
import { createDb } from "../db/client.js";
import { listRules } from "../db/rules.js";
import { categorize } from "./engine.js";
import { SEED_CATEGORY_NAMES, seedCategorizationRules } from "./seed-rules.js";

describe("seedCategorizationRules", () => {
  let db: Db;
  let close: () => void;

  beforeEach(() => {
    const opened = createDb(":memory:");
    db = opened.db;
    close = () => opened.sqlite.close();
  });

  afterEach(() => close());

  it("creates the three seed categories", async () => {
    await seedCategorizationRules(db);
    const categories = await listCategories(db);
    expect(categories.map((c) => c.name).sort()).toEqual([...SEED_CATEGORY_NAMES].sort());
  });

  it("is idempotent: running it twice creates no duplicate categories or rules", async () => {
    await seedCategorizationRules(db);
    await seedCategorizationRules(db);

    const categories = await listCategories(db);
    const rules = await listRules(db);

    expect(categories).toHaveLength(SEED_CATEGORY_NAMES.length);
    expect(rules).toHaveLength(new Set(rules.map((r) => r.matchValue)).size);
  });

  it("categorizes the full SPEC §2.6 seed-rule test matrix correctly", async () => {
    await seedCategorizationRules(db);
    const rules = await listRules(db);
    const categories = await listCategories(db);
    const categoryIdByName = new Map(categories.map((c) => [c.name, c.id]));

    const cases: Array<{ sellerName: string; expectedCategory: string }> = [
      { sellerName: "Energa Obrót S.A.", expectedCategory: "Media" },
      { sellerName: "Enea S.A.", expectedCategory: "Media" },
      { sellerName: "PGNiG Obrót Detaliczny", expectedCategory: "Media" },
      { sellerName: "T-Mobile Polska S.A.", expectedCategory: "Media" },
      { sellerName: "Wodociągi Miejskie Sp. z o.o.", expectedCategory: "Media" },
      { sellerName: "Zakład Gospodarki Odpady Komunalne", expectedCategory: "Media" },
      { sellerName: "Eurocash S.A.", expectedCategory: "Zakup towarów" },
      { sellerName: "Piwowar Dystrybucja", expectedCategory: "Zakup towarów" },
      { sellerName: "Pepsi Polska", expectedCategory: "Zakup towarów" },
      { sellerName: "Triada Sp. z o.o.", expectedCategory: "Zakup towarów" },
      { sellerName: "Ochrona Mienia Sp. z o.o.", expectedCategory: "Inne" },
      { sellerName: "Securitas Polska", expectedCategory: "Inne" },
      { sellerName: "ALD Leasing Polska", expectedCategory: "Inne" },
      { sellerName: "Skoda Auto Polska", expectedCategory: "Inne" },
      { sellerName: "OBI Sp. z o.o.", expectedCategory: "Inne" },
      { sellerName: "Castorama Polska", expectedCategory: "Inne" },
    ];

    for (const testCase of cases) {
      const result = categorize({ sellerNip: null, sellerName: testCase.sellerName }, rules);
      expect(result.confidence, `expected "${testCase.sellerName}" to match`).toBe("matched");
      expect(result.categoryId, `expected "${testCase.sellerName}" to categorize correctly`).toBe(
        categoryIdByName.get(testCase.expectedCategory),
      );
    }
  });

  it("flags an unmatched seller as needs_review rather than mis-categorizing it", async () => {
    await seedCategorizationRules(db);
    const rules = await listRules(db);

    const result = categorize({ sellerNip: null, sellerName: "Totally Unrelated Vendor" }, rules);
    expect(result).toEqual({ categoryId: null, confidence: "needs_review" });
  });
});
