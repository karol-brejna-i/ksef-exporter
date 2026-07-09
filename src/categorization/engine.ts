import type { CategorizationRule } from "../db/rules.js";

/** Minimal shape needed to categorize an invoice (SPEC §4). */
export interface CategorizableInvoice {
  sellerNip: string | null;
  sellerName: string;
}

export type CategorizationConfidence = "matched" | "needs_review";

export interface CategorizationResult {
  /** `null` when no rule matched (`confidence` will be `"needs_review"`). */
  categoryId: number | null;
  confidence: CategorizationConfidence;
}

/**
 * Tier-1 deterministic categorization (SPEC §4): seller NIP exact match is
 * checked first (preferred, stable identifier); a seller-name substring
 * match (case-insensitive) is the bootstrap/fallback. A pure function of
 * its inputs -- no I/O, no hidden state -- so the same (invoice, rules)
 * pair always produces the same result regardless of call order.
 */
export function categorize(
  invoice: CategorizableInvoice,
  rules: readonly CategorizationRule[],
): CategorizationResult {
  if (invoice.sellerNip !== null) {
    const nipRule = rules.find(
      (rule) => rule.matchType === "seller_nip" && rule.matchValue === invoice.sellerNip,
    );
    if (nipRule) {
      return { categoryId: nipRule.categoryId, confidence: "matched" };
    }
  }

  const sellerNameLower = invoice.sellerName.toLowerCase();
  const nameRule = rules.find(
    (rule) =>
      rule.matchType === "seller_name_contains" &&
      sellerNameLower.includes(rule.matchValue.toLowerCase()),
  );
  if (nameRule) {
    return { categoryId: nameRule.categoryId, confidence: "matched" };
  }

  return { categoryId: null, confidence: "needs_review" };
}
