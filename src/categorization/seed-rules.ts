import { createCategory, getCategoryByName } from "../db/categories.js";
import type { Db } from "../db/client.js";
import { upsertRule } from "../db/rules.js";

/** Categories used in the UI, per SPEC §2.6/HU-03. */
export const SEED_CATEGORY_NAMES = ["Media", "Zakup towarów", "Inne"] as const;
export type SeedCategoryName = (typeof SEED_CATEGORY_NAMES)[number];

/**
 * Tier-1 seed rules from design/SPEC.md §2.6 (derived from the historical
 * "ROZLICZENIE PARKOWA 2025.xlsx" spreadsheet analysis). These are
 * seller-name substring rules (bootstrap/fallback per SPEC §4) -- more
 * precise seller-NIP rules are added later via the Phase 5 correction
 * feedback loop.
 */
export const SEED_NAME_RULES: ReadonlyArray<{ keyword: string; category: SeedCategoryName }> = [
  { keyword: "energa", category: "Media" },
  { keyword: "enea", category: "Media" },
  { keyword: "pgnig", category: "Media" },
  { keyword: "t-mobile", category: "Media" },
  { keyword: "wodociąg", category: "Media" },
  { keyword: "odpady", category: "Media" },
  { keyword: "eurocash", category: "Zakup towarów" },
  { keyword: "piwowar", category: "Zakup towarów" },
  { keyword: "pepsi", category: "Zakup towarów" },
  { keyword: "triada", category: "Zakup towarów" },
  { keyword: "ochrona", category: "Inne" },
  { keyword: "securitas", category: "Inne" },
  { keyword: "leasing", category: "Inne" },
  { keyword: "skoda", category: "Inne" },
  { keyword: "obi", category: "Inne" },
  { keyword: "castorama", category: "Inne" },
];

/**
 * Idempotently loads the seed categories and Tier-1 name rules (SPEC §2.6)
 * into the database. Safe to call on every startup: creates categories
 * that don't exist yet, and upserts each rule (matchType/matchValue is the
 * upsert key -- see src/db/rules.ts) so re-running never creates
 * duplicates and always reflects the current list here.
 */
export async function seedCategorizationRules(db: Db): Promise<void> {
  const categoryIdByName = new Map<SeedCategoryName, number>();
  for (const name of SEED_CATEGORY_NAMES) {
    const existing = await getCategoryByName(db, name);
    const category = existing ?? (await createCategory(db, name));
    categoryIdByName.set(name, category.id);
  }

  for (const { keyword, category } of SEED_NAME_RULES) {
    const categoryId = categoryIdByName.get(category);
    if (categoryId === undefined) {
      throw new Error(`Seed rule references unknown category "${category}"`);
    }
    await upsertRule(db, { matchType: "seller_name_contains", matchValue: keyword, categoryId });
  }
}
