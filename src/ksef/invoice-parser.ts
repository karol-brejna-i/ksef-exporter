import { XMLParser } from "fast-xml-parser";
import { validateKsefNumber } from "ksef-client";

/**
 * Flat purchase-invoice record, per design/SPEC.md §3.4.
 * Field provenance (FA(2)/FA(3) schema, verified against the bundled
 * schemat_FA(3)_v1-0E.xsd): seller/buyer identity comes from
 * Faktura/Podmiot{1,2}/DaneIdentyfikacyjne/{NIP,Nazwa}; invoice number,
 * issue date, gross total, and currency come from Faktura/Fa/{P_2,P_1,P_15,KodWaluty}.
 * These field codes (P_1, P_2, P_15, ...) are stable across FA(1)/FA(2)/FA(3)
 * schema versions.
 */
/**
 * One `Faktura/Fa/FaWiersz` line, per design/INVOICE_ITEMS_PLAN.md §3.3 and the
 * bundled schemat_FA(3)_v1-0E.xsd. All 25 mapped children are `minOccurs="0"`
 * in the XSD (only `NrWierszaFa` is required, and even that is kept nullable so
 * a degenerate line is still emitted rather than dropped -- §6.2), so every
 * field except `ordinal` is nullable. None declares `maxOccurs > 1`, which is
 * what makes this flat shape lossless for FA(3).
 */
export interface InvoiceItemRecord {
  /**
   * 1-based position of this FaWiersz in document order. This -- NOT
   * `lineNumber` -- is the identity of a line: correction invoices
   * (RodzajFaktury = KOR) emit each line twice, once with StanPrzed and once
   * without, repeating NrWierszaFa (19 of 249 real invoices do).
   */
  ordinal: number;
  /** NrWierszaFa: the issuer's line number; not unique within an invoice. */
  lineNumber: number | null;
  /** UU_ID: issuer's unique line id (free-form text, not necessarily a UUID). */
  uuId: string | null;
  /** P_6A: per-line delivery/service date. */
  deliveryDate: string | null;
  /** P_7: name of the goods/service. */
  name: string | null;
  /** Indeks: issuer's internal product code (not reliably numeric). */
  indexCode: string | null;
  gtin: string | null;
  pkwiu: string | null;
  cn: string | null;
  pkob: string | null;
  /** P_8A, verbatim -- issuers write szt./SZT/Sztuki/kg./KG interchangeably. */
  unit: string | null;
  /** P_8B */
  quantity: number | null;
  /** P_9A */
  unitPriceNet: number | null;
  /** P_9B */
  unitPriceGross: number | null;
  /** P_10 */
  discount: number | null;
  /** P_11; absent on gross-priced lines (art. 106e ust. 7-8), which use P_11A. */
  netValue: number | null;
  /** P_11A */
  grossValue: number | null;
  /** P_11Vat */
  vatValue: number | null;
  /**
   * P_12, verbatim text and never numeric: TStawkaPodatku enumerates "zw",
   * "oo", "np I", "np II", "0 KR", "0 WDT", "0 EX" alongside 23/22/8/7/5/4/3.
   * Live data already contains "zw".
   */
  vatRate: string | null;
  /** P_12_XII: OSS VAT rate (ch. 6a). */
  vatRateOss: number | null;
  /** P_12_Zal_15: annex-15 goods marker (TWybor1, i.e. the string "1"). */
  annex15: boolean | null;
  /** KwotaAkcyzy */
  excise: number | null;
  /** GTU: GTU_01...GTU_13 reporting marker. */
  gtuCode: string | null;
  /** Procedura: WSTO_EE, IED, TT_D, I_42, ... */
  procedureCode: string | null;
  /** KursWaluty: per-line FX rate. */
  exchangeRate: number | null;
  /** StanPrzed: this row is the pre-correction state of its line number. */
  correctionStateBefore: boolean | null;
}

export interface PurchaseInvoiceRecord {
  /** KSeF number assigned by the KSeF system (not part of the invoice XML itself). */
  ksefNumber: string;
  /** Seller-assigned invoice number (Fa/P_2). */
  invoiceNumber: string;
  sellerNip: string;
  sellerName: string;
  buyerNip: string | null;
  buyerName: string | null;
  /** Issue date (Fa/P_1), ISO date string as present in the XML. */
  issueDate: string;
  /** Gross total due (Fa/P_15). */
  grossTotal: number;
  /** ISO 4217 currency code (Fa/KodWaluty). */
  currency: string;
  /** Raw invoice XML, retained for audit/debugging per SPEC §3.4. */
  rawXml: string;
  /**
   * Line items (Fa/FaWiersz), in document order. Empty is a valid state, not an
   * error: FaWiersz is `minOccurs="0"` (advance invoices, and corrections under
   * art. 106j ust. 3 pkt 2). Extraction is best-effort -- see `extractItems`.
   */
  items: InvoiceItemRecord[];
}

export class InvoiceParsingError extends Error {
  readonly fileName: string | undefined;

  constructor(message: string, fileName?: string) {
    super(fileName ? `${message} (file: ${fileName})` : message);
    this.name = "InvoiceParsingError";
    this.fileName = fileName;
  }
}

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  // Real-world KSeF invoice XML is inconsistent about namespace prefixes:
  // some documents use a default namespace (no prefix, e.g. `<Faktura>`),
  // others declare a prefixed one (e.g. `<ns0:Faktura>`/`<tns:Faktura>`).
  // The element/field names (Faktura, Podmiot1, P_1, ...) are stable
  // either way, so stripping prefixes lets one set of field paths handle
  // both without per-invoice branching.
  removeNSPrefix: true,
  // Keep every leaf as text. Coercing numeric-looking values would mangle
  // line-item data: GTIN/Indeks/PKWiU with leading zeros lose them
  // ("0012345678905" -> 12345678905), P_12 becomes a mixed `number | string`
  // (23 vs "zw"), and the declared precision of P_8B/P_9B ("2450.000000") is
  // gone before we see it. `asString()`/`parseAmount()` below already work on
  // text, so nothing downstream needs the coercion.
  parseTagValue: false,
});

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * fast-xml-parser collapses a repeated element to a bare object when it occurs
 * exactly once -- the case for 71 of 249 real invoices, which have a single
 * FaWiersz. Normalize so callers can always iterate.
 */
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value === undefined || value === null ? [] : [value];
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}

/**
 * Coerces an XML leaf to a number. Exported because `parseTagValue: false`
 * leaves every value as text, so any caller reading amounts straight off a
 * parsed element (e.g. the backfill's P_13_x reconciliation) needs the same
 * decimal-comma handling the mapped fields get.
 */
export function parseAmount(value: unknown): number | undefined {
  const str = asString(value);
  if (str === undefined) {
    return undefined;
  }
  const normalized = str.replace(",", ".");
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : undefined;
}

/**
 * `NrWierszaFa` is TNaturalny (an integer > 0). Truncate defensively so a
 * malformed decimal can't end up in an INTEGER column.
 */
function parseInteger(value: unknown): number | undefined {
  const amount = parseAmount(value);
  return amount === undefined ? undefined : Math.trunc(amount);
}

/**
 * `etd:TWybor1` has a single legal value: the string "1", meaning "yes".
 * Absent means "no information", which stays `undefined` (-> NULL).
 */
function parseWybor1(value: unknown): boolean | undefined {
  const str = asString(value);
  return str === undefined ? undefined : str === "1";
}

/** Metadata field names differ in casing across KSeF metadata payloads; check both. */
function extractKsefNumberFromMetadata(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  if (!metadata) {
    return undefined;
  }
  return asString(metadata.ksefNumber) ?? asString(metadata.KsefNumber);
}

/**
 * KSeF export packages name each invoice XML file after its KSeF number
 * (see design/SPEC.md §3.2). Used as a fallback when the corresponding
 * metadata entry (from `_metadata.json`) isn't available/matched.
 */
function extractKsefNumberFromFileName(fileName: string): string | undefined {
  const withoutExtension = fileName.replace(/\.xml$/i, "");
  return validateKsefNumber(withoutExtension).isValid ? withoutExtension : undefined;
}

/**
 * Maps one FaWiersz element. Never throws: a line missing P_7, or carrying no
 * amount fields at all, is still emitted with NULLs (design/INVOICE_ITEMS_PLAN.md
 * §6.2) -- `ordinal` preserves its position and `raw_xml` stays available for
 * inspection, so a visibly incomplete line beats a silently missing one.
 */
function parseInvoiceItem(value: unknown, ordinal: number): InvoiceItemRecord {
  const row = asRecord(value);

  return {
    ordinal,
    lineNumber: parseInteger(row.NrWierszaFa) ?? null,
    uuId: asString(row.UU_ID) ?? null,
    deliveryDate: asString(row.P_6A) ?? null,
    name: asString(row.P_7) ?? null,
    indexCode: asString(row.Indeks) ?? null,
    gtin: asString(row.GTIN) ?? null,
    pkwiu: asString(row.PKWiU) ?? null,
    cn: asString(row.CN) ?? null,
    pkob: asString(row.PKOB) ?? null,
    unit: asString(row.P_8A) ?? null,
    quantity: parseAmount(row.P_8B) ?? null,
    unitPriceNet: parseAmount(row.P_9A) ?? null,
    unitPriceGross: parseAmount(row.P_9B) ?? null,
    discount: parseAmount(row.P_10) ?? null,
    netValue: parseAmount(row.P_11) ?? null,
    grossValue: parseAmount(row.P_11A) ?? null,
    vatValue: parseAmount(row.P_11Vat) ?? null,
    // Verbatim: never parseAmount() here (see InvoiceItemRecord.vatRate).
    vatRate: asString(row.P_12) ?? null,
    vatRateOss: parseAmount(row.P_12_XII) ?? null,
    annex15: parseWybor1(row.P_12_Zal_15) ?? null,
    excise: parseAmount(row.KwotaAkcyzy) ?? null,
    gtuCode: asString(row.GTU) ?? null,
    procedureCode: asString(row.Procedura) ?? null,
    exchangeRate: parseAmount(row.KursWaluty) ?? null,
    correctionStateBefore: parseWybor1(row.StanPrzed) ?? null,
  };
}

/**
 * Parses an invoice XML document and returns its `Faktura/Fa` element, with
 * namespace prefixes stripped and every leaf left as text.
 *
 * Exists so line items can be re-derived from a stored `raw_xml` *without*
 * re-validating the header. `parsePurchaseInvoiceXml` deliberately throws when
 * a required header field is missing, and it resolves the KSeF number -- which
 * is not in the XML at all -- from the `fileName` argument. The backfill
 * (design/INVOICE_ITEMS_PLAN.md §5 Step 5) works on invoices whose header was
 * already parsed and persisted at import time, so routing it through that
 * function would make it pass a KSeF number in through a filename parameter and
 * would discard every item of any invoice whose header no longer satisfies the
 * current validation. Items are supplementary detail (§6.1) and must not
 * inherit header preconditions.
 *
 * Throws `InvoiceParsingError` only when the document itself is unparseable.
 * A document with no `Fa` element yields an empty record, not a throw.
 */
export function parseInvoiceFaElement(xml: string, fileName?: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xml);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new InvoiceParsingError(`Failed to parse invoice XML: ${message}`, fileName);
  }
  return asRecord(asRecord(asRecord(parsed).Faktura).Fa);
}

/**
 * Extracts the line items, best-effort. Items are supplementary detail, so --
 * unlike the required header fields -- nothing here may fail an invoice import
 * (design/INVOICE_ITEMS_PLAN.md §6.1): an unreadable items block yields the
 * lines parsed so far and leaves the header record intact. Whatever we couldn't
 * derive stays recoverable, because `raw_xml` is retained and the backfill can
 * re-derive every item after a parser improvement.
 */
export function extractInvoiceItems(fa: Record<string, unknown>): InvoiceItemRecord[] {
  const items: InvoiceItemRecord[] = [];
  try {
    for (const [index, row] of asArray(fa.FaWiersz).entries()) {
      items.push(parseInvoiceItem(row, index + 1));
    }
  } catch {
    // Deliberately swallowed: see the note above. Items already mapped are kept.
  }
  return items;
}

/**
 * Parses a single KSeF purchase-invoice XML document (FA(2)/FA(3)) into a
 * flat record. Throws `InvoiceParsingError` if the XML is malformed or is
 * missing a field this application depends on -- silently producing a
 * partially-populated financial record is worse than failing loudly.
 */
export function parsePurchaseInvoiceXml(
  fileName: string,
  xml: string,
  metadata?: Record<string, unknown>,
): PurchaseInvoiceRecord {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xml);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new InvoiceParsingError(`Failed to parse invoice XML: ${message}`, fileName);
  }

  const faktura = asRecord(asRecord(parsed).Faktura);
  const podmiot1 = asRecord(asRecord(faktura.Podmiot1).DaneIdentyfikacyjne);
  const podmiot2 = asRecord(asRecord(faktura.Podmiot2).DaneIdentyfikacyjne);
  const fa = asRecord(faktura.Fa);

  const ksefNumber =
    extractKsefNumberFromMetadata(metadata) ?? extractKsefNumberFromFileName(fileName);
  const sellerNip = asString(podmiot1.NIP);
  const sellerName = asString(podmiot1.Nazwa);
  const invoiceNumber = asString(fa.P_2);
  const issueDate = asString(fa.P_1);
  const grossTotal = parseAmount(fa.P_15);
  const currency = asString(fa.KodWaluty);

  const missing: string[] = [];
  if (!ksefNumber) missing.push("ksefNumber (metadata or file name)");
  if (!sellerNip) missing.push("Podmiot1/DaneIdentyfikacyjne/NIP");
  if (!sellerName) missing.push("Podmiot1/DaneIdentyfikacyjne/Nazwa");
  if (!invoiceNumber) missing.push("Fa/P_2");
  if (!issueDate) missing.push("Fa/P_1");
  if (grossTotal === undefined) missing.push("Fa/P_15");
  if (!currency) missing.push("Fa/KodWaluty");

  if (missing.length > 0) {
    throw new InvoiceParsingError(
      `Invoice XML is missing required field(s): ${missing.join(", ")}`,
      fileName,
    );
  }

  return {
    ksefNumber: ksefNumber as string,
    invoiceNumber: invoiceNumber as string,
    sellerNip: sellerNip as string,
    sellerName: sellerName as string,
    buyerNip: asString(podmiot2.NIP) ?? null,
    buyerName: asString(podmiot2.Nazwa) ?? null,
    issueDate: issueDate as string,
    grossTotal: grossTotal as number,
    currency: currency as string,
    rawXml: xml,
    items: extractInvoiceItems(fa),
  };
}
