/**
 * One-off tooling script (NOT part of the automated test suite / not part of
 * the phased IMPLEMENTATION_PLAN) that reconciles KSeF-pulled purchase
 * invoices (from `pnpm run dump:invoices`) against the owner's historical
 * spreadsheet cost entries (from `pnpm run extract:xlsx`) for the same
 * period, grouped by (normalized) seller/vendor name.
 *
 * Used to produce the May 2026 comparison in
 * design/reports/2026-05-ksef-vs-spreadsheet.md -- rerun this whenever a
 * new month needs the same comparison.
 *
 * Usage:
 *   pnpm run reconcile -- data/invoices/parsed.json data/comparison/maj-26.json
 */
import { readFileSync } from "node:fs";

interface KsefInvoice {
  sellerName: string;
  grossTotal: number;
}

interface SheetEntry {
  name: string;
  gross: number;
}

type SheetData = Record<string, SheetEntry[]>;

/** Categories that represent real invoices (can plausibly come from KSeF). "Koszty bez FV" (no-invoice costs, e.g. taxes/payroll/fees) and "Inewstycje" are intentionally excluded -- they structurally cannot/don't appear as KSeF purchase invoices. */
const INVOICE_ELIGIBLE_CATEGORIES = ["MEDIA", "ZAKUP TOWARÓW", "INNE"];

/**
 * Known name aliases that no automated (fuzzy or substring) matching could
 * reliably resolve, confirmed by a human via exact-amount coincidence
 * during the May 2026 analysis. Keyed by normalized sheet name -> raw KSeF
 * seller name. Extend this as new months surface more aliases.
 */
const KNOWN_ALIASES: Record<string, string> = {
  "ADA CHEMIA": "ADA FASHION ADRIANNA STAWOWY",
  "SMART SEREIS": "SMART SERWIS Dorota Walkowska",
  KSIEGOWA: "BIURO RACHUNKOWOŚCI ZYSK JULIA PRYCZKOWSKA",
  IMNTERWORKS: "INTERWORKS Mateusz Interewicz",
  "MARCIN MALEC": "EL-INFORMAR Marcin Malec",
  INFORM: "INFORM Marek Leżoń",
};

function normalize(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .toUpperCase()
    .replace(/\bKOREKTA\b/g, "") // merge correction/credit-note rows into their base vendor
    .replace(
      /\b(SP\.?\s*Z\s*O\.?\s*O\.?|SPOLKA.*|S\.?A\.?|SP\.?J\.?|SP\.?K\.?|SPOLDZIELNIA|SPZOO)\b/g,
      "",
    )
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/** Simple bigram (Dice coefficient) similarity -- no extra dependency needed for this one-off script. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const set = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      set.set(bg, (set.get(bg) ?? 0) + 1);
    }
    return set;
  };
  const bigramsA = bigrams(a);
  const bigramsB = bigrams(b);
  let overlap = 0;
  for (const [bg, count] of bigramsA) {
    overlap += Math.min(count, bigramsB.get(bg) ?? 0);
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

interface VendorAgg {
  total: number;
  count: number;
  display: string;
}

function aggregate<T>(items: T[], nameOf: (item: T) => string, amountOf: (item: T) => number) {
  const agg = new Map<string, VendorAgg>();
  for (const item of items) {
    const key = normalize(nameOf(item));
    const existing = agg.get(key);
    if (existing) {
      existing.total += amountOf(item);
      existing.count += 1;
    } else {
      agg.set(key, { total: amountOf(item), count: 1, display: nameOf(item) });
    }
  }
  return agg;
}

function main() {
  // `pnpm run reconcile -- ...` forwards the literal "--" through to this
  // script's argv on some pnpm/tsx versions -- skip it if present.
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const [ksefPath, sheetPath] = args;
  if (!ksefPath || !sheetPath) {
    console.error(
      "Usage: pnpm run reconcile -- <parsed-ksef-invoices.json> <sheet-comparison.json>",
    );
    process.exitCode = 1;
    return;
  }

  const ksefInvoices: KsefInvoice[] = JSON.parse(readFileSync(ksefPath, "utf-8"));
  const sheetData: SheetData = JSON.parse(readFileSync(sheetPath, "utf-8"));

  const ksefAgg = aggregate(
    ksefInvoices,
    (inv) => inv.sellerName,
    (inv) => inv.grossTotal,
  );

  const sheetEntries = INVOICE_ELIGIBLE_CATEGORIES.flatMap((cat) => sheetData[cat] ?? []);
  const sheetAgg = aggregate(
    sheetEntries,
    (e) => e.name,
    (e) => e.gross,
  );

  const usedKsefKeys = new Set<string>();
  const links = new Map<string, string>();

  // Pass 1: exact normalized-name match.
  for (const sheetKey of sheetAgg.keys()) {
    if (ksefAgg.has(sheetKey) && !usedKsefKeys.has(sheetKey)) {
      links.set(sheetKey, sheetKey);
      usedKsefKeys.add(sheetKey);
    }
  }

  // Pass 2: known human-confirmed aliases (see KNOWN_ALIASES above).
  for (const [sheetKey, sheetVal] of sheetAgg) {
    if (links.has(sheetKey)) continue;
    const aliasTarget = KNOWN_ALIASES[normalize(sheetVal.display)];
    if (!aliasTarget) continue;
    const aliasKey = normalize(aliasTarget);
    if (ksefAgg.has(aliasKey) && !usedKsefKeys.has(aliasKey)) {
      links.set(sheetKey, aliasKey);
      usedKsefKeys.add(aliasKey);
    }
  }

  // Pass 3: fuzzy bigram similarity among remaining, unclaimed pairs.
  for (const sheetKey of sheetAgg.keys()) {
    if (links.has(sheetKey)) continue;
    let best: string | undefined;
    let bestScore = 0;
    for (const ksefKey of ksefAgg.keys()) {
      if (usedKsefKeys.has(ksefKey)) continue;
      let score = similarity(sheetKey, ksefKey);
      if (sheetKey.length >= 4 && (sheetKey.includes(ksefKey) || ksefKey.includes(sheetKey))) {
        score = Math.max(score, 0.85);
      }
      if (score > bestScore) {
        best = ksefKey;
        bestScore = score;
      }
    }
    if (best && bestScore >= 0.72) {
      links.set(sheetKey, best);
      usedKsefKeys.add(best);
    }
  }

  const matched: Array<{ sheet: VendorAgg; ksef: VendorAgg }> = [];
  const sheetOnly: VendorAgg[] = [];
  for (const [sheetKey, sheetVal] of sheetAgg) {
    const ksefKey = links.get(sheetKey);
    const ksefVal = ksefKey ? ksefAgg.get(ksefKey) : undefined;
    if (ksefVal) {
      matched.push({ sheet: sheetVal, ksef: ksefVal });
    } else {
      sheetOnly.push(sheetVal);
    }
  }
  const ksefOnly = [...ksefAgg.entries()]
    .filter(([key]) => !usedKsefKeys.has(key))
    .map(([, val]) => val);

  const sum = (items: VendorAgg[], field: "total") => items.reduce((s, v) => s + v[field], 0);

  console.log(`Matched vendor groups: ${matched.length}`);
  console.log(
    `Sheet-only: ${sheetOnly.length} groups, ${sum(sheetOnly, "total").toFixed(2)} total`,
  );
  console.log(`KSeF-only: ${ksefOnly.length} groups, ${sum(ksefOnly, "total").toFixed(2)} total`);

  console.log("\n=== Matched (sheet vs KSeF) ===");
  for (const { sheet, ksef } of matched.sort((a, b) => b.sheet.total - a.sheet.total)) {
    const delta = sheet.total - ksef.total;
    const flag = Math.abs(delta) > 1 ? `  <- delta ${delta.toFixed(2)}` : "";
    console.log(
      `${sheet.display.padEnd(35).slice(0, 35)} sheet=${sheet.total.toFixed(2)}/${sheet.count} ksef=${ksef.total.toFixed(2)}/${ksef.count}${flag}`,
    );
  }

  console.log("\n=== Sheet-only (no KSeF match found) ===");
  for (const v of sheetOnly.sort((a, b) => b.total - a.total)) {
    console.log(`  ${v.display}: ${v.total.toFixed(2)} (${v.count})`);
  }

  console.log("\n=== KSeF-only (no sheet match found) ===");
  for (const v of ksefOnly.sort((a, b) => b.total - a.total)) {
    console.log(`  ${v.display}: ${v.total.toFixed(2)} (${v.count})`);
  }
}

main();
