import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    /**
     * When line items were last derived from raw_xml. NULL = never attempted,
     * which is what makes the backfill resumable and idempotent, and what lets
     * the UI distinguish "not extracted yet" from "genuinely has zero items"
     * (FaWiersz is minOccurs=0, so zero items is legal).
     */
    itemsExtractedAt: text("items_extracted_at"),
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
 * Line items (FaWiersz) of KSeF invoices, derived from invoices.raw_xml.
 * Each row is one line of an invoice, preserving document order.
 */
export const invoiceItems = sqliteTable(
  "invoice_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    invoiceId: integer("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    /**
     * 1-based position of this FaWiersz in document order. This -- NOT
     * NrWierszaFa -- is the stable identity of a line: correction invoices
     * (RodzajFaktury = KOR) repeat NrWierszaFa for the before/after pair
     * (19 of 249 real invoices do), so a unique key on the line number
     * would reject or silently halve them.
     */
    ordinal: integer("ordinal").notNull(),

    lineNumber: integer("line_number"), // NrWierszaFa
    uuId: text("uu_id"), // UU_ID
    deliveryDate: text("delivery_date"), // P_6A
    name: text("name"), // P_7
    indexCode: text("index_code"), // Indeks
    gtin: text("gtin"), // GTIN
    pkwiu: text("pkwiu"), // PKWiU
    cn: text("cn"), // CN
    pkob: text("pkob"), // PKOB
    /** P_8A, stored verbatim -- issuers write szt./SZT/Sztuki/kg./KG interchangeably. */
    unit: text("unit"),
    quantity: real("quantity"), // P_8B
    unitPriceNet: real("unit_price_net"), // P_9A
    unitPriceGross: real("unit_price_gross"), // P_9B
    discount: real("discount"), // P_10
    netValue: real("net_value"), // P_11  (absent on gross-priced lines)
    grossValue: real("gross_value"), // P_11A
    vatValue: real("vat_value"), // P_11Vat
    /**
     * P_12. TEXT, never numeric: TStawkaPodatku enumerates "zw", "oo",
     * "np I", "np II", "0 KR", "0 WDT", "0 EX" alongside 23/22/8/7/5/4/3.
     * Live data already contains "zw".
     */
    vatRate: text("vat_rate"),
    vatRateOss: real("vat_rate_oss"), // P_12_XII
    annex15: integer("annex15", { mode: "boolean" }), // P_12_Zal_15
    excise: real("excise"), // KwotaAkcyzy
    gtuCode: text("gtu_code"), // GTU
    procedureCode: text("procedure_code"), // Procedura
    exchangeRate: real("exchange_rate"), // KursWaluty
    /** StanPrzed: this row is the pre-correction state of its line number. */
    correctionStateBefore: integer("correction_state_before", { mode: "boolean" }),
  },
  (table) => [
    uniqueIndex("invoice_items_invoice_ordinal_unique").on(table.invoiceId, table.ordinal),
    index("invoice_items_invoice_id_idx").on(table.invoiceId),
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
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  durationMs: integer("duration_ms"),
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
  continuationBefore: text("continuation_before"),
  continuationAfter: text("continuation_after"),
  fetchedCount: integer("fetched_count"),
  insertedCount: integer("inserted_count"),
  duplicateCount: integer("duplicate_count"),
  categorizedCount: integer("categorized_count"),
  needsReviewCount: integer("needs_review_count"),
  hasMore: integer("has_more", { mode: "boolean" }),
  maxIterations: integer("max_iterations"),
  errorType: text("error_type"),
  errorCode: text("error_code"),
  httpStatus: integer("http_status"),
  retryAfterSeconds: integer("retry_after_seconds"),
  /** Items written across the run; NULL on rows predating this workstream. */
  itemsInsertedCount: integer("items_inserted_count"),
  /** Invoices whose item extraction failed; the invoice itself is still stored (§6.1). */
  itemsFailedCount: integer("items_failed_count"),
});
