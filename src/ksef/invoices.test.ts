import type { KsefClient } from "ksef-client";
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

interface FakePackage {
  invoiceCount: number;
  size: number;
  parts: unknown[];
  isTruncated: boolean;
  lastPermanentStorageDate?: string | null;
  permanentStorageHwmDate?: string | null;
}

interface FakeIteration {
  referenceNumber: string;
  package: FakePackage;
  metadataSummaries: Array<Record<string, unknown>>;
  invoiceXmlFiles: Record<string, string>;
}

function fakePackage(overrides: Partial<FakePackage> = {}): FakePackage {
  return {
    invoiceCount: 0,
    size: 0,
    parts: [],
    isTruncated: false,
    lastPermanentStorageDate: null,
    permanentStorageHwmDate: null,
    ...overrides,
  };
}

/**
 * Builds a fake `client.workflows.exports` that plays back one `FakeIteration`
 * per call cycle (startExport -> waitForExport -> downloadAndProcessPackage),
 * advancing to the next configured iteration only once all three have been
 * called for the current one. This mirrors how `fetchPurchaseInvoices` now
 * calls these three primitives directly instead of going through
 * `exportsIncremental.run()` (see design/KSEF_PAGINATION_AND_HASMORE.md §7.1).
 */
function fakeClient(iterations: FakeIteration[]): {
  client: Pick<KsefClient, "workflows">;
  startExport: ReturnType<typeof vi.fn>;
  waitForExport: ReturnType<typeof vi.fn>;
  downloadAndProcessPackage: ReturnType<typeof vi.fn>;
} {
  let call = 0;

  const currentIteration = (): FakeIteration => {
    const iteration = iterations[call];
    if (!iteration) {
      throw new Error(`test fixture bug: no fake iteration configured for call index ${call}`);
    }
    return iteration;
  };

  const startExport = vi.fn().mockImplementation(async () => {
    const iteration = currentIteration();
    return { referenceNumber: iteration.referenceNumber, encryptionData: {} };
  });
  const waitForExport = vi.fn().mockImplementation(async () => {
    const iteration = currentIteration();
    return {
      status: { code: 200 },
      package: iteration.package,
    };
  });
  const downloadAndProcessPackage = vi.fn().mockImplementation(async () => {
    const iteration = currentIteration();
    call += 1;
    return {
      metadataSummaries: iteration.metadataSummaries,
      invoiceXmlFiles: iteration.invoiceXmlFiles,
    };
  });

  const client = {
    workflows: {
      exports: { startExport, waitForExport, downloadAndProcessPackage },
    },
  } as unknown as Pick<KsefClient, "workflows">;

  return { client, startExport, waitForExport, downloadAndProcessPackage };
}

describe("fetchPurchaseInvoices", () => {
  it("queries Subject2 (buyer role) with PermanentStorage-based date range and requireExportPartHash", async () => {
    const { client, startExport, downloadAndProcessPackage } = fakeClient([
      {
        referenceNumber: "ref-1",
        package: fakePackage(),
        metadataSummaries: [],
        invoiceXmlFiles: {},
      },
    ]);

    await fetchPurchaseInvoices(client, {
      windowFrom: "2025-01-01",
      windowTo: "2025-01-31",
      continuationPoints: {},
      maxIterations: 1,
    });

    expect(startExport).toHaveBeenCalledWith({
      filters: expect.objectContaining({
        subjectType: "Subject2",
        dateRange: expect.objectContaining({
          dateType: "PermanentStorage",
          from: "2025-01-01",
          to: "2025-01-31",
        }),
      }),
    });
    expect(downloadAndProcessPackage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ requireExportPartHash: true }),
    );
  });

  it("queries Subject1 when subjectType is passed explicitly (sales invoices)", async () => {
    const { client, startExport } = fakeClient([
      {
        referenceNumber: "ref-1",
        package: fakePackage(),
        metadataSummaries: [],
        invoiceXmlFiles: {},
      },
    ]);

    await fetchPurchaseInvoices(client, {
      windowFrom: "2025-01-01",
      windowTo: "2025-01-31",
      continuationPoints: {},
      subjectType: "Subject1",
      maxIterations: 1,
    });

    expect(startExport).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ subjectType: "Subject1" }),
      }),
    );
  });

  it("passes through polling and attempt options to waitForExport", async () => {
    const { client, waitForExport } = fakeClient([
      {
        referenceNumber: "ref-1",
        package: fakePackage(),
        metadataSummaries: [],
        invoiceXmlFiles: {},
      },
    ]);

    await fetchPurchaseInvoices(client, {
      windowFrom: "2025-01-01",
      windowTo: "2025-01-31",
      continuationPoints: {},
      maxIterations: 1,
      pollIntervalMs: 1000,
      maxAttempts: 30,
    });

    expect(waitForExport).toHaveBeenCalledWith("ref-1", { pollIntervalMs: 1000, maxAttempts: 30 });
  });

  it("parses returned invoice XML files into flat records, matching metadata by KSeF number", async () => {
    const { client } = fakeClient([
      {
        referenceNumber: "ref-1",
        package: fakePackage({ invoiceCount: 2 }),
        metadataSummaries: [
          { ksefNumber: KSEF_NUMBER_1, extra: "ignored" },
          { KsefNumber: KSEF_NUMBER_2 },
        ],
        invoiceXmlFiles: {
          [`${KSEF_NUMBER_1}.xml`]: invoiceXml("5265877635", "Energa Operator"),
          [`${KSEF_NUMBER_2}.xml`]: invoiceXml("9999999999", "Eurocash"),
        },
      },
    ]);

    const result = await fetchPurchaseInvoices(client, {
      windowFrom: "2025-01-01",
      windowTo: "2025-01-31",
      continuationPoints: {},
      maxIterations: 1,
    });

    expect(result.invoices).toHaveLength(2);
    expect(result.invoices.map((invoice) => invoice.ksefNumber).sort()).toEqual(
      [KSEF_NUMBER_1, KSEF_NUMBER_2].sort(),
    );
    expect(result.invoices.find((i) => i.ksefNumber === KSEF_NUMBER_1)?.sellerName).toBe(
      "Energa Operator",
    );
    expect(result.referenceNumbers).toEqual(["ref-1"]);
  });

  it("propagates a clear parsing error instead of silently dropping a malformed invoice", async () => {
    const { client } = fakeClient([
      {
        referenceNumber: "ref-1",
        package: fakePackage({ invoiceCount: 1 }),
        metadataSummaries: [],
        invoiceXmlFiles: { [`${KSEF_NUMBER_1}.xml`]: "<Faktura><broken" },
      },
    ]);

    await expect(
      fetchPurchaseInvoices(client, {
        windowFrom: "2025-01-01",
        windowTo: "2025-01-31",
        continuationPoints: {},
        maxIterations: 1,
      }),
    ).rejects.toThrow(InvoiceParsingError);
  });

  describe("single iteration (maxIterations: 1, the real production sync path)", () => {
    it("surfaces isTruncated/lastPermanentStorageDate for a truncated package", async () => {
      const { client } = fakeClient([
        {
          referenceNumber: "ref-1",
          package: fakePackage({
            invoiceCount: 1,
            isTruncated: true,
            lastPermanentStorageDate: "2025-01-10T00:00:00Z",
            permanentStorageHwmDate: null,
          }),
          metadataSummaries: [],
          invoiceXmlFiles: {},
        },
      ]);

      const result = await fetchPurchaseInvoices(client, {
        windowFrom: "2025-01-01",
        windowTo: "2025-01-31",
        continuationPoints: {},
        maxIterations: 1,
      });

      expect(result.isTruncated).toBe(true);
      expect(result.lastPermanentStorageDate).toBe("2025-01-10T00:00:00Z");
      expect(result.permanentStorageHwmDate).toBeNull();
    });

    it("surfaces isTruncated/permanentStorageHwmDate for a non-truncated package", async () => {
      const { client } = fakeClient([
        {
          referenceNumber: "ref-1",
          package: fakePackage({
            invoiceCount: 0,
            isTruncated: false,
            lastPermanentStorageDate: null,
            permanentStorageHwmDate: "2025-01-31T12:00:00Z",
          }),
          metadataSummaries: [],
          invoiceXmlFiles: {},
        },
      ]);

      const result = await fetchPurchaseInvoices(client, {
        windowFrom: "2025-01-01",
        windowTo: "2025-01-31",
        continuationPoints: {},
        maxIterations: 1,
      });

      expect(result.isTruncated).toBe(false);
      expect(result.lastPermanentStorageDate).toBeNull();
      expect(result.permanentStorageHwmDate).toBe("2025-01-31T12:00:00Z");
    });
  });

  it("accumulates across iterations, stops once the continuation point stalls, and reflects the LAST iteration's status", async () => {
    const { client, startExport } = fakeClient([
      {
        referenceNumber: "ref-1",
        package: fakePackage({
          invoiceCount: 1,
          isTruncated: true,
          lastPermanentStorageDate: "2025-01-10T00:00:00Z",
          permanentStorageHwmDate: null,
        }),
        metadataSummaries: [{ ksefNumber: KSEF_NUMBER_1 }],
        invoiceXmlFiles: { [`${KSEF_NUMBER_1}.xml`]: invoiceXml("5265877635", "Energa Operator") },
      },
      {
        referenceNumber: "ref-2",
        // Same resulting continuation-point value as iteration 1
        // (permanentStorageHwmDate === iteration 1's lastPermanentStorageDate)
        // -- this is what makes getEffectiveStartDate return an unchanged
        // effectiveFrom, so the loop breaks here instead of running a 3rd
        // time. isTruncated is flipped to false here specifically so the
        // test can distinguish "reflects the last status" from "reflects
        // the first status".
        package: fakePackage({
          invoiceCount: 1,
          isTruncated: false,
          lastPermanentStorageDate: null,
          permanentStorageHwmDate: "2025-01-10T00:00:00Z",
        }),
        metadataSummaries: [{ ksefNumber: KSEF_NUMBER_2 }],
        invoiceXmlFiles: { [`${KSEF_NUMBER_2}.xml`]: invoiceXml("9999999999", "Eurocash") },
      },
      {
        // Never reached -- if the loop incorrectly ran a 3rd time, startExport's
        // call count assertion below would fail before this is used.
        referenceNumber: "ref-3",
        package: fakePackage(),
        metadataSummaries: [],
        invoiceXmlFiles: {},
      },
    ]);

    const result = await fetchPurchaseInvoices(client, {
      windowFrom: "2025-01-01",
      windowTo: "2025-01-31",
      continuationPoints: {},
      maxIterations: 3,
    });

    expect(startExport).toHaveBeenCalledTimes(2);
    expect(result.referenceNumbers).toEqual(["ref-1", "ref-2"]);
    expect(result.invoices.map((invoice) => invoice.ksefNumber).sort()).toEqual(
      [KSEF_NUMBER_1, KSEF_NUMBER_2].sort(),
    );
    // Reflects the LAST executed iteration (index 1), not the first.
    expect(result.isTruncated).toBe(false);
    expect(result.lastPermanentStorageDate).toBeNull();
    expect(result.permanentStorageHwmDate).toBe("2025-01-10T00:00:00Z");
  });

  it("does not produce a duplicate invoice when the same KSeF number recurs across iterations (dedupeByKsefNumber's contract)", async () => {
    const { client, startExport } = fakeClient([
      {
        referenceNumber: "ref-1",
        package: fakePackage({
          invoiceCount: 1,
          isTruncated: true,
          lastPermanentStorageDate: "2025-01-10T00:00:00Z",
          permanentStorageHwmDate: null,
        }),
        metadataSummaries: [{ ksefNumber: KSEF_NUMBER_1, extra: "first-iteration" }],
        invoiceXmlFiles: { [`${KSEF_NUMBER_1}.xml`]: invoiceXml("5265877635", "Energa Operator") },
      },
      {
        referenceNumber: "ref-2",
        // Overlapping window re-returns the same invoice's metadata (same
        // ksefNumber, different payload) and the same XML file a second
        // time. The final result must still contain it exactly once.
        package: fakePackage({
          invoiceCount: 1,
          isTruncated: false,
          lastPermanentStorageDate: null,
          permanentStorageHwmDate: "2025-01-20T00:00:00Z",
        }),
        metadataSummaries: [{ ksefNumber: KSEF_NUMBER_1, extra: "second-iteration" }],
        invoiceXmlFiles: { [`${KSEF_NUMBER_1}.xml`]: invoiceXml("5265877635", "Energa Operator") },
      },
    ]);

    const result = await fetchPurchaseInvoices(client, {
      windowFrom: "2025-01-01",
      windowTo: "2025-01-31",
      continuationPoints: {},
      // Capped at exactly the 2 configured fake iterations -- this test is
      // about dedupe, not about the stall-detection behavior covered above.
      maxIterations: 2,
    });

    expect(startExport).toHaveBeenCalledTimes(2);
    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0]?.ksefNumber).toBe(KSEF_NUMBER_1);
  });
});
