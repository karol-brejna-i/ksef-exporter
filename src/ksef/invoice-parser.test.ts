import { crc8Hex } from "ksef-client";
import { describe, expect, it } from "vitest";
import { InvoiceParsingError, parsePurchaseInvoiceXml } from "./invoice-parser.js";

/** Builds a syntactically valid (per validateKsefNumber) 35-char KSeF number. */
function buildValidKsefNumber(main32: string): string {
  if (main32.length !== 32) {
    throw new Error("test fixture bug: main32 must be exactly 32 characters");
  }
  // validateKsefNumber expects exactly 35 chars: a 32-char main block (used
  // for the checksum), one filler character it doesn't otherwise validate,
  // and a trailing 2-char checksum computed from the main block.
  return `${main32}0${crc8Hex(main32)}`;
}

const SAMPLE_KSEF_NUMBER = buildValidKsefNumber("5265877635".padEnd(32, "0"));

function buildInvoiceXml(overrides: {
  sellerNip?: string;
  sellerName?: string;
  buyerNip?: string;
  buyerName?: string;
  invoiceNumber?: string;
  issueDate?: string;
  grossTotal?: string;
  currency?: string;
  /** Raw `FaWiersz` markup, appended inside `Fa`. Must use the same prefix. */
  itemsXml?: string;
  /** Namespace prefix, without the colon. Empty means a default namespace. */
  prefix?: string;
}): string {
  const {
    sellerNip = "5265877635",
    sellerName = "Parkowa Dostawca Sp. z o.o.",
    buyerNip = "1111111111",
    buyerName = "Parkowa Sp. z o.o.",
    invoiceNumber = "FV/2025/01/001",
    issueDate = "2025-01-15",
    grossTotal = "1234.56",
    currency = "PLN",
    itemsXml = "",
    prefix = "",
  } = overrides;

  // Real invoices arrive in all three prefix styles (§3.2: 139 unprefixed,
  // 57 `tns:`, 53 `ns0:`), so the fixture parameterizes it rather than
  // hard-coding one.
  const p = prefix ? `${prefix}:` : "";
  const xmlns = prefix
    ? `xmlns:${prefix}="http://crd.gov.pl/wzor/2025/06/25/13775/"`
    : `xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/"`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<${p}Faktura ${xmlns}>
  <${p}Naglowek>
    <${p}KodFormularza kodSystemowy="FA (3)" wersjaSchemy="1-0E">FA</${p}KodFormularza>
  </${p}Naglowek>
  <${p}Podmiot1>
    <${p}DaneIdentyfikacyjne>
      <${p}NIP>${sellerNip}</${p}NIP>
      <${p}Nazwa>${sellerName}</${p}Nazwa>
    </${p}DaneIdentyfikacyjne>
  </${p}Podmiot1>
  <${p}Podmiot2>
    <${p}DaneIdentyfikacyjne>
      <${p}NIP>${buyerNip}</${p}NIP>
      <${p}Nazwa>${buyerName}</${p}Nazwa>
    </${p}DaneIdentyfikacyjne>
  </${p}Podmiot2>
  <${p}Fa>
    <${p}KodWaluty>${currency}</${p}KodWaluty>
    <${p}P_1>${issueDate}</${p}P_1>
    <${p}P_2>${invoiceNumber}</${p}P_2>
    <${p}P_15>${grossTotal}</${p}P_15>
${itemsXml}
  </${p}Fa>
</${p}Faktura>`;
}

/**
 * Invoice `84` (design/INVOICE_ITEMS_PLAN.md §3.8) -- a line carrying both net
 * and gross prices -- with the element prefix parameterized. The `tns:` form is
 * the verbatim sample; the other two are the same content in the other two
 * observed serialization styles.
 */
function bothPricesItemXml(prefix: string): string {
  const p = prefix ? `${prefix}:` : "";
  return `<${p}FaWiersz>
    <${p}NrWierszaFa>1</${p}NrWierszaFa>
    <${p}P_7>SKU: 7832 / GIRLANDA 20M 20x E27</${p}P_7>
    <${p}P_8A>szt.</${p}P_8A>
    <${p}P_8B>5</${p}P_8B>
    <${p}P_9A>41.72</${p}P_9A>
    <${p}P_9B>51.32</${p}P_9B>
    <${p}P_11>208.62</${p}P_11>
    <${p}P_11A>256.6</${p}P_11A>
    <${p}P_12>23</${p}P_12>
  </${p}FaWiersz>`;
}

/** Invoice `247` (§3.8): the minimal, gross-priced, VAT-exempt single line. */
const GROSS_PRICED_EXEMPT_ITEM_XML =
  "<FaWiersz><NrWierszaFa>1</NrWierszaFa><P_7>Usługa Administracyjna</P_7><P_8A>usł.</P_8A><P_8B>1</P_8B><P_9B>5500</P_9B><P_11A>5500</P_11A><P_12>zw</P_12></FaWiersz>";

/** Invoice `203` (§3.8): fully-coded goods line (UU_ID + Indeks + GTIN + PKWiU + CN). */
const FULLY_CODED_ITEM_XML =
  "<FaWiersz><NrWierszaFa>1</NrWierszaFa><UU_ID>71611272</UU_ID><P_7>Stripsy z kurczaka 1kg-AJFOOD(6)</P_7><Indeks>FARM-G-0025</Indeks><GTIN>5904978715476</GTIN><PKWiU>10.31.15.0</PKWiU><CN>1602 32 19</CN><P_8A>szt.</P_8A><P_8B>6.00</P_8B><P_9A>41.19</P_9A><P_11>247.14</P_11><P_12>5</P_12></FaWiersz>";

/** Invoice `100` (§3.8): utility line with a per-line date and excise duty. */
const UTILITY_ITEM_XML = `<FaWiersz>
    <NrWierszaFa>2</NrWierszaFa>
    <P_6A>2026-06-30</P_6A>
    <P_7>590243831008467439 Energia elektryczna czynna szczytowa</P_7>
    <P_8A>kWh</P_8A>
    <P_8B>483</P_8B>
    <P_9A>0.59</P_9A>
    <P_11>284.97</P_11>
    <P_12>23</P_12>
    <KwotaAkcyzy>2.42</KwotaAkcyzy>
</FaWiersz>`;

/**
 * The correction pair from `data/example.invoice.xml` (§3.8): both rows carry
 * `NrWierszaFa` = 1, and only the first has `StanPrzed`.
 */
const CORRECTION_PAIR_ITEMS_XML = `<ns0:FaWiersz>
    <ns0:NrWierszaFa>1</ns0:NrWierszaFa>
    <ns0:P_7>_KEG 50 l TYCHY+LECH NOWA KAUCJA</ns0:P_7>
    <ns0:Indeks>371184</ns0:Indeks>
    <ns0:GTIN>20807474</ns0:GTIN>
    <ns0:P_8A>SZT</ns0:P_8A>
    <ns0:P_8B>3.000</ns0:P_8B>
    <ns0:P_9A>243.90</ns0:P_9A>
    <ns0:P_11>731.70</ns0:P_11>
    <ns0:P_12>23</ns0:P_12>
    <ns0:StanPrzed>1</ns0:StanPrzed>
</ns0:FaWiersz>
<ns0:FaWiersz>
    <ns0:NrWierszaFa>1</ns0:NrWierszaFa>
    <ns0:P_7>_KEG 50 l TYCHY+LECH NOWA KAUCJA</ns0:P_7>
    <ns0:Indeks>371184</ns0:Indeks>
    <ns0:GTIN>20807474</ns0:GTIN>
    <ns0:P_8A>SZT</ns0:P_8A>
    <ns0:P_8B>0.000</ns0:P_8B>
    <ns0:P_9A>0.00</ns0:P_9A>
    <ns0:P_11>0.00</ns0:P_11>
    <ns0:P_12>23</ns0:P_12>
</ns0:FaWiersz>`;

/**
 * Exercises the fields that are rare (or absent) in the current data but are
 * still legal FA(3): P_10, P_11Vat, P_12_XII, P_12_Zal_15, PKOB, GTU,
 * Procedura, KursWaluty. Values follow the distributions in §3.3.
 */
const RARE_FIELDS_ITEM_XML = `<FaWiersz>
    <NrWierszaFa>3</NrWierszaFa>
    <UU_ID>5a9d9266-1fca-4bbe-a347-0d4af9a5da12</UU_ID>
    <P_7>Sprzedaż węgla</P_7>
    <PKOB>1121</PKOB>
    <P_8A>kg</P_8A>
    <P_8B>2450.000000</P_8B>
    <P_9A>1.50</P_9A>
    <P_10>25.00</P_10>
    <P_11>3650.00</P_11>
    <P_11A>4489.50</P_11A>
    <P_11Vat>839.50</P_11Vat>
    <P_12>23</P_12>
    <P_12_XII>21</P_12_XII>
    <P_12_Zal_15>1</P_12_Zal_15>
    <KwotaAkcyzy>12.30</KwotaAkcyzy>
    <GTU>GTU_01</GTU>
    <Procedura>WSTO_EE</Procedura>
    <KursWaluty>1.0000</KursWaluty>
</FaWiersz>`;

/** Every `InvoiceItemRecord` field null except `ordinal` -- the §6.2 baseline. */
function blankItem(ordinal: number) {
  return {
    ordinal,
    lineNumber: null,
    uuId: null,
    deliveryDate: null,
    name: null,
    indexCode: null,
    gtin: null,
    pkwiu: null,
    cn: null,
    pkob: null,
    unit: null,
    quantity: null,
    unitPriceNet: null,
    unitPriceGross: null,
    discount: null,
    netValue: null,
    grossValue: null,
    vatValue: null,
    vatRate: null,
    vatRateOss: null,
    annex15: null,
    excise: null,
    gtuCode: null,
    procedureCode: null,
    exchangeRate: null,
    correctionStateBefore: null,
  };
}

describe("parsePurchaseInvoiceXml", () => {
  it("parses a well-formed invoice into a flat record, preferring metadata for the KSeF number", () => {
    const xml = buildInvoiceXml({});

    const record = parsePurchaseInvoiceXml("some-file.xml", xml, {
      ksefNumber: SAMPLE_KSEF_NUMBER,
    });

    expect(record).toEqual({
      ksefNumber: SAMPLE_KSEF_NUMBER,
      invoiceNumber: "FV/2025/01/001",
      sellerNip: "5265877635",
      sellerName: "Parkowa Dostawca Sp. z o.o.",
      buyerNip: "1111111111",
      buyerName: "Parkowa Sp. z o.o.",
      issueDate: "2025-01-15",
      grossTotal: 1234.56,
      currency: "PLN",
      rawXml: xml,
      items: [],
    });
  });

  it("falls back to deriving the KSeF number from the file name when metadata doesn't have it", () => {
    const xml = buildInvoiceXml({});

    const record = parsePurchaseInvoiceXml(`${SAMPLE_KSEF_NUMBER}.xml`, xml);

    expect(record.ksefNumber).toBe(SAMPLE_KSEF_NUMBER);
  });

  it("accepts the KsefNumber (capitalized) metadata field variant", () => {
    const xml = buildInvoiceXml({});

    const record = parsePurchaseInvoiceXml("some-file.xml", xml, {
      KsefNumber: SAMPLE_KSEF_NUMBER,
    });

    expect(record.ksefNumber).toBe(SAMPLE_KSEF_NUMBER);
  });

  it("normalizes a comma-decimal gross total", () => {
    const xml = buildInvoiceXml({ grossTotal: "1234,56" });

    const record = parsePurchaseInvoiceXml(`${SAMPLE_KSEF_NUMBER}.xml`, xml);

    expect(record.grossTotal).toBe(1234.56);
  });

  it("throws InvoiceParsingError for malformed XML", () => {
    expect(() => parsePurchaseInvoiceXml("bad.xml", "<Faktura><unclosed>")).toThrowError(
      InvoiceParsingError,
    );
  });

  it("throws InvoiceParsingError listing every missing required field", () => {
    const emptyXml = "<Faktura></Faktura>";

    expect(() => parsePurchaseInvoiceXml("bad.xml", emptyXml)).toThrowError(
      /ksefNumber.*Podmiot1\/DaneIdentyfikacyjne\/NIP.*Podmiot1\/DaneIdentyfikacyjne\/Nazwa.*Fa\/P_2.*Fa\/P_1.*Fa\/P_15.*Fa\/KodWaluty/s,
    );
  });

  it("does not derive a KSeF number from a file name that fails checksum validation", () => {
    const xml = buildInvoiceXml({});

    expect(() => parsePurchaseInvoiceXml("not-a-valid-ksef-number.xml", xml)).toThrowError(
      /ksefNumber/,
    );
  });

  it("parses an invoice XML that uses a prefixed namespace instead of a default one", () => {
    // Regression test: real PROD KSeF invoices were observed using
    // `<ns0:Faktura xmlns:ns0="...">` / `<tns:Faktura xmlns:tns="...">`
    // instead of the default-namespace form used elsewhere in this file --
    // this broke parsing entirely until `removeNSPrefix: true` was added.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ns0:Faktura xmlns:ns0="http://crd.gov.pl/wzor/2025/06/25/13775/">
  <ns0:Podmiot1>
    <ns0:DaneIdentyfikacyjne>
      <ns0:NIP>5265877635</ns0:NIP>
      <ns0:Nazwa>Parkowa Dostawca Sp. z o.o.</ns0:Nazwa>
    </ns0:DaneIdentyfikacyjne>
  </ns0:Podmiot1>
  <ns0:Podmiot2>
    <ns0:DaneIdentyfikacyjne>
      <ns0:NIP>1111111111</ns0:NIP>
      <ns0:Nazwa>Parkowa Sp. z o.o.</ns0:Nazwa>
    </ns0:DaneIdentyfikacyjne>
  </ns0:Podmiot2>
  <ns0:Fa>
    <ns0:KodWaluty>PLN</ns0:KodWaluty>
    <ns0:P_1>2025-01-15</ns0:P_1>
    <ns0:P_2>FV/2025/01/001</ns0:P_2>
    <ns0:P_15>1234.56</ns0:P_15>
  </ns0:Fa>
</ns0:Faktura>`;

    const record = parsePurchaseInvoiceXml(`${SAMPLE_KSEF_NUMBER}.xml`, xml);

    expect(record.sellerNip).toBe("5265877635");
    expect(record.sellerName).toBe("Parkowa Dostawca Sp. z o.o.");
    expect(record.invoiceNumber).toBe("FV/2025/01/001");
    expect(record.grossTotal).toBe(1234.56);
    expect(record.currency).toBe("PLN");
  });
});

describe("parsePurchaseInvoiceXml line items", () => {
  it("maps every FaWiersz field, in document order", () => {
    const xml = buildInvoiceXml({
      itemsXml: [FULLY_CODED_ITEM_XML, UTILITY_ITEM_XML, RARE_FIELDS_ITEM_XML].join("\n"),
    });

    const record = parsePurchaseInvoiceXml(`${SAMPLE_KSEF_NUMBER}.xml`, xml);

    expect(record.items).toHaveLength(3);
    expect(record.items.map((item) => item.ordinal)).toEqual([1, 2, 3]);
    expect(record.items[0]).toEqual({
      ...blankItem(1),
      lineNumber: 1,
      uuId: "71611272",
      name: "Stripsy z kurczaka 1kg-AJFOOD(6)",
      indexCode: "FARM-G-0025",
      gtin: "5904978715476",
      pkwiu: "10.31.15.0",
      cn: "1602 32 19",
      unit: "szt.",
      quantity: 6,
      unitPriceNet: 41.19,
      netValue: 247.14,
      vatRate: "5",
    });
    expect(record.items[1]).toEqual({
      ...blankItem(2),
      lineNumber: 2,
      deliveryDate: "2026-06-30",
      name: "590243831008467439 Energia elektryczna czynna szczytowa",
      unit: "kWh",
      quantity: 483,
      unitPriceNet: 0.59,
      netValue: 284.97,
      vatRate: "23",
      excise: 2.42,
    });
    expect(record.items[2]).toEqual({
      ...blankItem(3),
      lineNumber: 3,
      uuId: "5a9d9266-1fca-4bbe-a347-0d4af9a5da12",
      name: "Sprzedaż węgla",
      pkob: "1121",
      unit: "kg",
      quantity: 2450,
      unitPriceNet: 1.5,
      discount: 25,
      netValue: 3650,
      grossValue: 4489.5,
      vatValue: 839.5,
      vatRate: "23",
      vatRateOss: 21,
      annex15: true,
      excise: 12.3,
      gtuCode: "GTU_01",
      procedureCode: "WSTO_EE",
      exchangeRate: 1,
    });
  });

  it("yields an array of one for a single-item invoice", () => {
    // fast-xml-parser collapses a lone repeated element to a bare object;
    // 71 of 249 real invoices have exactly one FaWiersz (§5 Step 2).
    const xml = buildInvoiceXml({ itemsXml: FULLY_CODED_ITEM_XML });

    const record = parsePurchaseInvoiceXml(`${SAMPLE_KSEF_NUMBER}.xml`, xml);

    expect(record.items).toHaveLength(1);
    expect(record.items[0]?.ordinal).toBe(1);
    expect(record.items[0]?.name).toBe("Stripsy z kurczaka 1kg-AJFOOD(6)");
  });

  it("extracts identical items from all three namespace-prefix styles", () => {
    const items = ["", "tns", "ns0"].map(
      (prefix) =>
        parsePurchaseInvoiceXml(
          `${SAMPLE_KSEF_NUMBER}.xml`,
          buildInvoiceXml({ prefix, itemsXml: bothPricesItemXml(prefix) }),
        ).items,
    );

    expect(items[0]).toEqual([
      {
        ...blankItem(1),
        lineNumber: 1,
        name: "SKU: 7832 / GIRLANDA 20M 20x E27",
        unit: "szt.",
        quantity: 5,
        unitPriceNet: 41.72,
        unitPriceGross: 51.32,
        netValue: 208.62,
        grossValue: 256.6,
        vatRate: "23",
      },
    ]);
    expect(items[1]).toEqual(items[0]);
    expect(items[2]).toEqual(items[0]);
  });

  it("keeps a non-numeric VAT rate such as zw as a verbatim string", () => {
    const xml = buildInvoiceXml({ itemsXml: GROSS_PRICED_EXEMPT_ITEM_XML });

    const record = parsePurchaseInvoiceXml(`${SAMPLE_KSEF_NUMBER}.xml`, xml);

    // TStawkaPodatku enumerates strings; a numeric column/type would corrupt
    // "zw"/"oo"/"np I"/"0 WDT" on contact (§3.5b).
    expect(record.items[0]?.vatRate).toBe("zw");
    // Numeric-looking rates stay strings too, so the type is never mixed.
    const numericRate = parsePurchaseInvoiceXml(
      `${SAMPLE_KSEF_NUMBER}.xml`,
      buildInvoiceXml({ itemsXml: FULLY_CODED_ITEM_XML }),
    );
    expect(numericRate.items[0]?.vatRate).toBe("5");
  });

  it("leaves netValue null on a gross-priced line and keeps the gross value", () => {
    // 151 of 2 437 real item rows have no P_11 (art. 106e ust. 7-8); all of
    // them carry P_11A instead, so no row ends up valueless (§3.5c).
    const xml = buildInvoiceXml({ itemsXml: GROSS_PRICED_EXEMPT_ITEM_XML });

    const record = parsePurchaseInvoiceXml(`${SAMPLE_KSEF_NUMBER}.xml`, xml);

    expect(record.items[0]).toEqual({
      ...blankItem(1),
      lineNumber: 1,
      name: "Usługa Administracyjna",
      unit: "usł.",
      quantity: 1,
      unitPriceGross: 5500,
      netValue: null,
      grossValue: 5500,
      vatRate: "zw",
    });
  });

  it("distinguishes correction rows that share NrWierszaFa by ordinal and StanPrzed", () => {
    const xml = buildInvoiceXml({ prefix: "ns0", itemsXml: CORRECTION_PAIR_ITEMS_XML });

    const record = parsePurchaseInvoiceXml(`${SAMPLE_KSEF_NUMBER}.xml`, xml);

    expect(record.items).toHaveLength(2);
    // Both rows are line 1 of the invoice -- the ordinal is the only identity
    // that separates the pre-correction row from the post-correction one.
    expect(record.items.map((item) => item.lineNumber)).toEqual([1, 1]);
    expect(record.items.map((item) => item.ordinal)).toEqual([1, 2]);
    expect(record.items.map((item) => item.correctionStateBefore)).toEqual([true, null]);
    expect(record.items.map((item) => item.netValue)).toEqual([731.7, 0]);
  });

  it("preserves leading zeros in GTIN and Indeks", () => {
    // parseTagValue: false guarantee -- numeric coercion would turn
    // "0012345678905" into 12345678905 and silently corrupt the code.
    const xml = buildInvoiceXml({
      itemsXml:
        "<FaWiersz><NrWierszaFa>1</NrWierszaFa><P_7>Kawa</P_7><Indeks>00371184</Indeks><GTIN>0012345678905</GTIN><P_8B>1</P_8B><P_11>10.00</P_11><P_12>23</P_12></FaWiersz>",
    });

    const record = parsePurchaseInvoiceXml(`${SAMPLE_KSEF_NUMBER}.xml`, xml);

    expect(record.items[0]?.gtin).toBe("0012345678905");
    expect(record.items[0]?.indexCode).toBe("00371184");
  });

  it("still parses the header when a FaWiersz is empty or unreadable", () => {
    // §6.1/§6.2: items are supplementary detail, so a degenerate line is
    // emitted positionally with NULLs and never fails the invoice import.
    const xml = buildInvoiceXml({
      itemsXml: `<FaWiersz></FaWiersz>${FULLY_CODED_ITEM_XML}`,
    });

    const record = parsePurchaseInvoiceXml(`${SAMPLE_KSEF_NUMBER}.xml`, xml);

    expect(record.grossTotal).toBe(1234.56);
    expect(record.sellerNip).toBe("5265877635");
    expect(record.items).toHaveLength(2);
    expect(record.items[0]).toEqual(blankItem(1));
    expect(record.items[1]?.name).toBe("Stripsy z kurczaka 1kg-AJFOOD(6)");
  });

  it("returns no items for an invoice without any FaWiersz", () => {
    // FaWiersz is minOccurs="0": advance invoices and some corrections
    // legitimately have none, which is not an error (§6.3).
    const record = parsePurchaseInvoiceXml(`${SAMPLE_KSEF_NUMBER}.xml`, buildInvoiceXml({}));

    expect(record.items).toEqual([]);
  });
});
