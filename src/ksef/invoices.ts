import type {
  ContinuationPoints,
  DownloadPackageOptions,
  ExportResult,
  InvoiceExportStatusResponse,
  InvoiceQueryFilters,
  KsefClient,
  PackageProcessingResult,
} from "ksef-client";
import { dedupeByKsefNumber, getEffectiveStartDate, updateContinuationPoint } from "ksef-client";
import { type PurchaseInvoiceRecord, parsePurchaseInvoiceXml } from "./invoice-parser.js";

/**
 * "Subject2" is the buyer role in KSeF's model (see design/SPEC.md §3).
 * Default when the caller doesn't specify one -- keeps existing purchase-only
 * callers unchanged. "Subject1" (seller role) is used for sales invoices
 * (see design/SALES_INVOICES_PLAN.md).
 */
const PURCHASE_INVOICE_SUBJECT_TYPE = "Subject2";

export interface FetchPurchaseInvoicesOptions {
  /** Start of the overall date range to sync, ISO date or date-time. */
  windowFrom: string;
  /** End of the overall date range to sync, ISO date or date-time. */
  windowTo: string;
  /**
   * High-water-mark continuation state from a previous run (per subject
   * type), as returned by a previous call. Pass `{}` for a first-ever sync.
   */
  continuationPoints: ContinuationPoints;
  /** KSeF subject type to query. Defaults to "Subject2" (buyer/purchases). */
  subjectType?: string;
  /** Safety cap on how many export iterations a single call may perform. */
  maxIterations?: number;
  pollIntervalMs?: number;
  maxAttempts?: number;
}

export interface FetchPurchaseInvoicesResult {
  invoices: PurchaseInvoiceRecord[];
  /** Updated continuation state; persist and pass into the next call. */
  continuationPoints: ContinuationPoints;
  referenceNumbers: string[];
  /**
   * KSeF's own authoritative "more data in this window" signal
   * (`InvoicePackage.isTruncated`) for the package this call fetched.
   * Undefined until the `exportsIncremental.run()` call below is replaced
   * with the three lower-level calls it wraps -- that wrapper computes this
   * value internally and currently discards it before it reaches this
   * function. See design/KSEF_PAGINATION_AND_HASMORE.md §2.1/§7.1.
   */
  isTruncated?: boolean;
  /** Real data pointer, populated when `isTruncated` is true. Same doc, §2.1. */
  lastPermanentStorageDate?: string | null;
  /** Server high-water mark, populated when `isTruncated` is false. Same doc, §2.1. */
  permanentStorageHwmDate?: string | null;
}

/**
 * Fetches all purchase invoices (KSeF `Subject2` / buyer role) for the given
 * window.
 *
 * This replicates `client.workflows.exportsIncremental.run()`'s own
 * start-export -> poll -> download -> decrypt -> unzip -> dedupe -> HWM
 * continuation loop (see `IncrementalExportWorkflow.run()` in the `ksef-client`
 * package) by calling the same three lower-level primitives
 * (`client.workflows.exports.startExport/waitForExport/downloadAndProcessPackage`)
 * directly, instead of going through that wrapper. The wrapper computes
 * `InvoicePackage.isTruncated` internally (via `updateContinuationPoint`) but
 * never returns it, which is exactly the signal `hasMore` needs to stop
 * over-reporting -- see design/KSEF_PAGINATION_AND_HASMORE.md §2.1/§7.1 for
 * the full incident writeup. Everything else -- polling, decryption, package
 * handling, dedupe -- is still done by the SDK; only the one-line wrapper
 * that discards `isTruncated` is bypassed.
 *
 * Defaults to `DateType = PermanentStorage` (the SPEC-mandated, delay-immune
 * date type for incremental sync, see design/SPEC.md §3.2).
 */
export async function fetchPurchaseInvoices(
  client: Pick<KsefClient, "workflows">,
  options: FetchPurchaseInvoicesOptions,
): Promise<FetchPurchaseInvoicesResult> {
  const subjectType = options.subjectType ?? PURCHASE_INVOICE_SUBJECT_TYPE;
  const continuationPoints = options.continuationPoints;
  const maxIterations = options.maxIterations ?? 20;

  const referenceNumbers: string[] = [];
  const combinedXmlFiles: Record<string, string> = {};
  const combinedMetadata: Array<Record<string, unknown>> = [];
  // Tracks the *last* iteration's status, whether the loop ran to
  // maxIterations or broke early on a stalled continuation point -- the
  // isTruncated/HWM fields we return must reflect that final call, not the
  // first one.
  let lastStatus: InvoiceExportStatusResponse | undefined;

  let effectiveFrom = getEffectiveStartDate(continuationPoints, subjectType, options.windowFrom);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const filters = {
      subjectType,
      dateRange: {
        dateType: "PermanentStorage",
        from: effectiveFrom,
        to: options.windowTo,
      },
    } as unknown as InvoiceQueryFilters;

    const started: ExportResult = await client.workflows.exports.startExport({ filters });
    referenceNumbers.push(started.referenceNumber);

    const waitOptions = {
      ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
      ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    };
    const status: InvoiceExportStatusResponse = await client.workflows.exports.waitForExport(
      started.referenceNumber,
      waitOptions,
    );
    lastStatus = status;

    const downloadOptions: DownloadPackageOptions = { requireExportPartHash: true };
    const processed: PackageProcessingResult =
      await client.workflows.exports.downloadAndProcessPackage(
        status,
        started.encryptionData,
        downloadOptions,
      );

    combinedMetadata.push(...processed.metadataSummaries);
    for (const [name, content] of Object.entries(processed.invoiceXmlFiles)) {
      combinedXmlFiles[name] = content;
    }

    updateContinuationPoint(continuationPoints, subjectType, status.package ?? {}, {
      dateType: filters.dateRange?.dateType,
    });

    const nextFrom = getEffectiveStartDate(continuationPoints, subjectType, options.windowFrom);
    if (nextFrom === effectiveFrom) {
      break;
    }
    effectiveFrom = nextFrom;
  }

  const deduped = dedupeByKsefNumber(combinedMetadata);
  const metadataSummaries = Object.values(deduped);

  const metadataByKsefNumber = new Map<string, Record<string, unknown>>();
  for (const summary of metadataSummaries) {
    const ksefNumber = summary.ksefNumber ?? summary.KsefNumber;
    if (typeof ksefNumber === "string") {
      metadataByKsefNumber.set(ksefNumber, summary);
    }
  }

  const invoices = Object.entries(combinedXmlFiles).map(([fileName, xml]) => {
    const guessedKsefNumber = fileName.replace(/\.xml$/i, "");
    const metadata = metadataByKsefNumber.get(guessedKsefNumber);
    return parsePurchaseInvoiceXml(fileName, xml, metadata);
  });

  return {
    invoices,
    continuationPoints,
    referenceNumbers,
    ...(lastStatus?.package?.isTruncated !== undefined
      ? { isTruncated: lastStatus.package.isTruncated }
      : {}),
    ...(lastStatus?.package?.lastPermanentStorageDate !== undefined
      ? { lastPermanentStorageDate: lastStatus.package.lastPermanentStorageDate }
      : {}),
    ...(lastStatus?.package?.permanentStorageHwmDate !== undefined
      ? { permanentStorageHwmDate: lastStatus.package.permanentStorageHwmDate }
      : {}),
  };
}
