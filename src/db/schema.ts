import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Categories used in the UI (per design/SPEC.md §2.6/§4): Media, Zakup
 * towarów (purchased goods), Inne (other). Kept as a table (not a fixed
 * enum) so new categories can be added later without a schema change.
 */
export const categories = sqliteTable(
  "categories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
  },
  (table) => [uniqueIndex("categories_name_unique").on(table.name)],
);

/**
 * Purchase invoices, from KSeF or manually entered (SPEC §2.5/§4: manual
 * entries are structurally similar, distinguished only by `source`).
 */
export const invoices = sqliteTable(
  "invoices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** "ksef" (pulled via the KSeF sync) or "manual" (HU-02 exceptions). */
    source: text("source", { enum: ["ksef", "manual"] }).notNull(),
    /** Null for manual entries that have no KSeF number (e.g. foreign vendor). */
    ksefNumber: text("ksef_number"),
    invoiceNumber: text("invoice_number").notNull(),
    sellerNip: text("seller_nip"),
    sellerName: text("seller_name").notNull(),
    buyerNip: text("buyer_nip"),
    buyerName: text("buyer_name"),
    /** ISO date string (Fa/P_1 for KSeF invoices). */
    issueDate: text("issue_date").notNull(),
    grossTotal: real("gross_total").notNull(),
    currency: text("currency").notNull(),
    /** Null for manual entries; retained for audit/debugging per SPEC §3.4. */
    rawXml: text("raw_xml"),
    categoryId: integer("category_id").references(() => categories.id),
    /**
     * "matched": a Tier-1 rule confidently assigned the category (SPEC §4).
     * "needs_review": no rule matched; awaiting human confirmation (HU-03).
     */
    categorizationConfidence: text("categorization_confidence", {
      enum: ["matched", "needs_review"],
    })
      .notNull()
      .default("needs_review"),
    createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
  },
  (table) => [
    // A KSeF invoice must never be stored twice; manual entries have no
    // KSeF number at all (multiple NULLs are allowed by SQLite's unique
    // index semantics, which is exactly what we want here).
    uniqueIndex("invoices_ksef_number_unique").on(table.ksefNumber),
  ],
);

/**
 * Tier-1 deterministic categorization rules (SPEC §2.6/§4). A correction
 * made via the UI (HU-04) creates/updates one of these.
 */
export const categorizationRules = sqliteTable(
  "categorization_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** "seller_nip" (exact match, preferred) or "seller_name_contains" (fallback). */
    matchType: text("match_type", { enum: ["seller_nip", "seller_name_contains"] }).notNull(),
    matchValue: text("match_value").notNull(),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id),
  },
  (table) => [
    // Prevents duplicate/conflicting rules for the same match condition;
    // corrections update the existing rule instead (SPEC §4, Phase 5).
    uniqueIndex("categorization_rules_match_unique").on(table.matchType, table.matchValue),
  ],
);

/**
 * High-water-mark continuation state for incremental KSeF sync (SPEC §3.2),
 * one row per KSeF subject type (we only use "Subject2" today).
 */
export const syncState = sqliteTable("sync_state", {
  subjectType: text("subject_type").primaryKey(),
  /** ISO date-time continuation point, or null before the first sync. */
  continuationPoint: text("continuation_point"),
});

/**
 * A record of each triggered import (HU-01), so the owner can confirm an
 * import happened and how it went (SPEC §2.2 NFR 5, Phase 7) instead of
 * only ever seeing the resulting invoices with no trace of the request
 * that produced them.
 */
export const syncRuns = sqliteTable("sync_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requestedAt: text("requested_at").notNull().default(sql`(current_timestamp)`),
  windowFrom: text("window_from").notNull(),
  windowTo: text("window_to").notNull(),
  /** "running" until the sync call resolves, then "success" or "error". */
  status: text("status", { enum: ["running", "success", "error"] })
    .notNull()
    .default("running"),
  /** Set once `status` is "success". */
  invoiceCount: integer("invoice_count"),
  /** Set once `status` is "error". */
  errorMessage: text("error_message"),
});
