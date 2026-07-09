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
  } = overrides;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/">
  <Naglowek>
    <KodFormularza kodSystemowy="FA (3)" wersjaSchemy="1-0E">FA</KodFormularza>
  </Naglowek>
  <Podmiot1>
    <DaneIdentyfikacyjne>
      <NIP>${sellerNip}</NIP>
      <Nazwa>${sellerName}</Nazwa>
    </DaneIdentyfikacyjne>
  </Podmiot1>
  <Podmiot2>
    <DaneIdentyfikacyjne>
      <NIP>${buyerNip}</NIP>
      <Nazwa>${buyerName}</Nazwa>
    </DaneIdentyfikacyjne>
  </Podmiot2>
  <Fa>
    <KodWaluty>${currency}</KodWaluty>
    <P_1>${issueDate}</P_1>
    <P_2>${invoiceNumber}</P_2>
    <P_15>${grossTotal}</P_15>
  </Fa>
</Faktura>`;
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
