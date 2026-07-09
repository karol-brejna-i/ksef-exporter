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
});

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
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

function parseAmount(value: unknown): number | undefined {
  const str = asString(value);
  if (str === undefined) {
    return undefined;
  }
  const normalized = str.replace(",", ".");
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : undefined;
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
  };
}
