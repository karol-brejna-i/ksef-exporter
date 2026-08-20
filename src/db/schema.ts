import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * These are spliced into CHECK constraints as raw SQL. Interpolating plain JS
 * values instead emits bound `?` parameters, which SQLite rejects in DDL.
 */
const ISO_DATE_GLOB = sql.raw("'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'");
const NIP_GLOB = sql.raw("'[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'");
/** 2000-01-01 .. 2100-01-01 in epoch ms. Catches a value written in *seconds*,
 * which is the likeliest regression now that instants are integers. */
const EPOCH_MS_MIN = sql.raw("946684800000");
const EPOCH_MS_MAX = sql.raw("4102444800000");

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
    itemsExtractedAt: integer("items_extracted_at", { mode: "timestamp_ms" }),
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
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    // A KSeF invoice must never be stored twice; manual entries have no
    // KSeF number at all (multiple NULLs are allowed by SQLite's unique
    // index semantics, which is exactly what we want here).
    uniqueIndex("invoices_ksef_number_unique").on(table.ksefNumber),
    index("invoices_issue_date_idx").on(table.issueDate),
    check(
      "invoices_issue_date_iso",
      sql`${table.issueDate} GLOB ${ISO_DATE_GLOB} AND ${table.issueDate} IS date(${table.issueDate})`,
    ),
    check("invoices_source_enum", sql`${table.source} IN ('ksef', 'manual')`),
    check(
      "invoices_confidence_enum",
      sql`${table.categorizationConfidence} IN ('matched', 'needs_review')`,
    ),
    check("invoices_currency_iso", sql`${table.currency} GLOB '[A-Z][A-Z][A-Z]'`),
    check(
      "invoices_seller_nip_digits",
      sql`${table.sellerNip} IS NULL OR ${table.sellerNip} GLOB ${NIP_GLOB}`,
    ),
    check(
      "invoices_buyer_nip_digits",
      sql`${table.buyerNip} IS NULL OR ${table.buyerNip} GLOB ${NIP_GLOB}`,
    ),
    check(
      "invoices_created_at_epoch_ms",
      sql`${table.createdAt} BETWEEN ${EPOCH_MS_MIN} AND ${EPOCH_MS_MAX}`,
    ),
    check(
      "invoices_items_extracted_at_epoch_ms",
      sql`${table.itemsExtractedAt} IS NULL OR ${table.itemsExtractedAt} BETWEEN ${EPOCH_MS_MIN} AND ${EPOCH_MS_MAX}`,
    ),
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
    check("invoice_items_ordinal_positive", sql`${table.ordinal} >= 1`),
    check(
      "invoice_items_delivery_date_iso",
      sql`${table.deliveryDate} IS NULL OR (${table.deliveryDate} GLOB ${ISO_DATE_GLOB} AND ${table.deliveryDate} IS date(${table.deliveryDate}))`,
    ),
    check(
      "invoice_items_annex15_bool",
      sql`${table.annex15} IS NULL OR ${table.annex15} IN (0, 1)`,
    ),
    check(
      "invoice_items_correction_state_bool",
      sql`${table.correctionStateBefore} IS NULL OR ${table.correctionStateBefore} IN (0, 1)`,
    ),
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
    check(
      "categorization_rules_match_type_enum",
      sql`${table.matchType} IN ('seller_nip', 'seller_name_contains')`,
    ),
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
export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    requestedAt: integer("requested_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
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
  },
  (table) => [
    check("sync_runs_status_enum", sql`${table.status} IN ('running', 'success', 'error')`),
    check("sync_runs_has_more_bool", sql`${table.hasMore} IS NULL OR ${table.hasMore} IN (0, 1)`),
    check(
      "sync_runs_window_from_iso",
      sql`${table.windowFrom} GLOB ${ISO_DATE_GLOB} AND ${table.windowFrom} IS date(${table.windowFrom})`,
    ),
    check(
      "sync_runs_window_to_iso",
      sql`${table.windowTo} GLOB ${ISO_DATE_GLOB} AND ${table.windowTo} IS date(${table.windowTo})`,
    ),
    check("sync_runs_window_order", sql`${table.windowFrom} <= ${table.windowTo}`),
    check(
      "sync_runs_requested_at_epoch_ms",
      sql`${table.requestedAt} BETWEEN ${EPOCH_MS_MIN} AND ${EPOCH_MS_MAX}`,
    ),
    check(
      "sync_runs_started_at_epoch_ms",
      sql`${table.startedAt} IS NULL OR ${table.startedAt} BETWEEN ${EPOCH_MS_MIN} AND ${EPOCH_MS_MAX}`,
    ),
    check(
      "sync_runs_completed_at_epoch_ms",
      sql`${table.completedAt} IS NULL OR ${table.completedAt} BETWEEN ${EPOCH_MS_MIN} AND ${EPOCH_MS_MAX}`,
    ),
  ],
);
