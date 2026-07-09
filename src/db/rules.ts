import { and, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { categorizationRules } from "./schema.js";

export type RuleMatchType = "seller_nip" | "seller_name_contains";

export interface CategorizationRule {
  id: number;
  matchType: RuleMatchType;
  matchValue: string;
  categoryId: number;
}

/**
 * Creates a rule, or updates the category of an existing rule with the same
 * (matchType, matchValue) -- e.g. when a human corrects a seller's category
 * more than once (SPEC §4, Phase 5), we must not accumulate duplicate/
 * conflicting rules for the same condition.
 */
export async function upsertRule(
  db: Db,
  rule: { matchType: RuleMatchType; matchValue: string; categoryId: number },
): Promise<CategorizationRule> {
  const [row] = await db
    .insert(categorizationRules)
    .values(rule)
    .onConflictDoUpdate({
      target: [categorizationRules.matchType, categorizationRules.matchValue],
      set: { categoryId: rule.categoryId },
    })
    .returning();
  if (!row) {
    throw new Error("Failed to upsert categorization rule: no row returned");
  }
  return row;
}

export async function findRule(
  db: Db,
  matchType: RuleMatchType,
  matchValue: string,
): Promise<CategorizationRule | undefined> {
  return db.query.categorizationRules.findFirst({
    where: and(
      eq(categorizationRules.matchType, matchType),
      eq(categorizationRules.matchValue, matchValue),
    ),
  });
}

export async function listRules(db: Db): Promise<CategorizationRule[]> {
  return db.select().from(categorizationRules).all();
}

export async function deleteRule(db: Db, id: number): Promise<void> {
  await db.delete(categorizationRules).where(eq(categorizationRules.id, id)).run();
}
