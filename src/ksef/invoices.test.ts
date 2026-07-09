import type { IncrementalExportResult, KsefClient } from "ksef-client";
import { crc8Hex } from "ksef-client";
import { describe, expect, it, vi } from "vitest";
import { InvoiceParsingError } from "./invoice-parser.js";
import { fetchPurchaseInvoices } from "./invoices.js";

function buildValidKsefNumber(main32: string): string {
  if (main32.length !== 32) {
    throw new Error("test fixture bug: main32 must be exactly 32 characters");
  }
  // See src/ksef/invoice-parser.test.ts for why this is 32 + 1 + 2 chars.
  return `${main32}0${crc8Hex(main32)}`;
}

const KSEF_NUMBER_1 = buildValidKsefNumber("5265877635".padEnd(32, "1"));
const KSEF_NUMBER_2 = buildValidKsefNumber("5265877635".padEnd(32, "2"));

function invoiceXml(sellerNip: string, sellerName: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/">
  <Podmiot1>
    <DaneIdentyfikacyjne>
      <NIP>${sellerNip}</NIP>
      <Nazwa>${sellerName}</Nazwa>
    </DaneIdentyfikacyjne>
  </Podmiot1>
  <Podmiot2>
    <DaneIdentyfikacyjne>
      <NIP>1111111111</NIP>
      <Nazwa>Parkowa Sp. z o.o.</Nazwa>
    </DaneIdentyfikacyjne>
  </Podmiot2>
  <Fa>
    <KodWaluty>PLN</KodWaluty>
    <P_1>2025-01-15</P_1>
    <P_2>FV/1</P_2>
    <P_15>100.00</P_15>
  </Fa>
</Faktura>`;
}

function fakeClient(runResult: IncrementalExportResult): {
  client: Pick<KsefClient, "workflows">;
  run: ReturnType<typeof vi.fn>;
} {
  const run = vi.fn().mockResolvedValue(runResult);
  const client = {
    workflows: {
      exportsIncremental: { run },
    },
  } as unknown as Pick<KsefClient, "workflows">;
  return { client, run };
}

describe("fetchPurchaseInvoices", () => {
  it("queries Subject2 (buyer role) with PermanentStorage-based incremental export and requireExportPartHash", async () => {
    const { client, run } = fakeClient({
      referenceNumbers: [],
      metadataSummaries: [],
      invoiceXmlFiles: {},
      continuationPoints: {},
    });

    await fetchPurchaseInvoices(client, {
      windowFrom: "2025-01-01",
      windowTo: "2025-01-31",
      continuationPoints: {},
    });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "Subject2",
        windowFrom: "2025-01-01",
        windowTo: "2025-01-31",
        continuationPoints: {},
        requireExportPartHash: true,
      }),
    );
  });

  it("parses returned invoice XML files into flat records, matching metadata by KSeF number", async () => {
    const { client } = fakeClient({
      referenceNumbers: ["ref-1"],
      metadataSummaries: [
        { ksefNumber: KSEF_NUMBER_1, extra: "ignored" },
        { KsefNumber: KSEF_NUMBER_2 },
      ],
      invoiceXmlFiles: {
        [`${KSEF_NUMBER_1}.xml`]: invoiceXml("5265877635", "Energa Operator"),
        [`${KSEF_NUMBER_2}.xml`]: invoiceXml("9999999999", "Eurocash"),
      },
      continuationPoints: { Subject2: "2025-01-16T00:00:00Z" },
    });

    const result = await fetchPurchaseInvoices(client, {
      windowFrom: "2025-01-01",
      windowTo: "2025-01-31",
      continuationPoints: {},
    });

    expect(result.invoices).toHaveLength(2);
    expect(result.invoices.map((invoice) => invoice.ksefNumber).sort()).toEqual(
      [KSEF_NUMBER_1, KSEF_NUMBER_2].sort(),
    );
    expect(result.invoices.find((i) => i.ksefNumber === KSEF_NUMBER_1)?.sellerName).toBe(
      "Energa Operator",
    );
    expect(result.continuationPoints).toEqual({ Subject2: "2025-01-16T00:00:00Z" });
    expect(result.referenceNumbers).toEqual(["ref-1"]);
  });

  it("propagates a clear parsing error instead of silently dropping a malformed invoice", async () => {
    const { client } = fakeClient({
      referenceNumbers: ["ref-1"],
      metadataSummaries: [],
      invoiceXmlFiles: {
        [`${KSEF_NUMBER_1}.xml`]: "<Faktura><broken",
      },
      continuationPoints: {},
    });

    await expect(
      fetchPurchaseInvoices(client, {
        windowFrom: "2025-01-01",
        windowTo: "2025-01-31",
        continuationPoints: {},
      }),
    ).rejects.toThrow(InvoiceParsingError);
  });

  it("passes through polling and iteration options", async () => {
    const { client, run } = fakeClient({
      referenceNumbers: [],
      metadataSummaries: [],
      invoiceXmlFiles: {},
      continuationPoints: {},
    });

    await fetchPurchaseInvoices(client, {
      windowFrom: "2025-01-01",
      windowTo: "2025-01-31",
      continuationPoints: {},
      maxIterations: 5,
      pollIntervalMs: 1000,
      maxAttempts: 30,
    });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        maxIterations: 5,
        pollIntervalMs: 1000,
        maxAttempts: 30,
      }),
    );
  });
});
