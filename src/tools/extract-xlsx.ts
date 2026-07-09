/**
 * One-off tooling script (NOT part of the app engine / not covered by the
 * phased IMPLEMENTATION_PLAN) to extract the cost-invoice mini-tables from
 * a monthly tab of the owner's historical spreadsheet
 * (`design/ROZLICZENIE PARKOWA 2025.xlsx`), so we can compare them against
 * what our KSeF pipeline actually pulls for the same period.
 *
 * The spreadsheet's layout (verified against the "MAJ 26" tab): row 1 has
 * column headers, and cost-related categories are laid out as adjacent
 * (name, "BRUTTO" amount[, "NETTO" amount]) column pairs/triples, e.g.
 * `MEDIA | BRUTTO | NETTO` at columns M/N/O, each subsequent row being one
 * line item (seller/description + gross amount) rather than a single
 * aligned table -- the different mini-tables have unrelated row counts.
 *
 * Output is written to `data/comparison/<sheet-slug>.json` (gitignored --
 * this is the owner's real business data) as
 * `{ [categoryName]: Array<{ name: string; gross: number; net?: number }> }`.
 *
 * Usage:
 *   pnpm run extract:xlsx -- "MAJ 26"
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";

/** Categories relevant to cost-invoice categorization (SPEC §2.6/§4); revenue/payroll columns (e.g. "RAPORTY MSC", "WYPŁATY") are intentionally skipped. */
const COST_CATEGORIES = new Set(["INEWSTYCJE", "MEDIA", "ZAKUP TOWARÓW", "INNE", "KOSZTY BEZ FV"]);

interface CostEntry {
  name: string;
  gross: number;
  net?: number;
}

function slugify(sheetName: string): string {
  return sheetName.trim().toLowerCase().replace(/\s+/g, "-");
}

function extractCostEntries(sheet: XLSX.WorkSheet): Record<string, CostEntry[]> {
  const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1");
  const result: Record<string, CostEntry[]> = {};

  for (let col = range.s.c; col <= range.e.c; col++) {
    const headerCell = sheet[XLSX.utils.encode_cell({ r: range.s.r, c: col })];
    const header = typeof headerCell?.v === "string" ? headerCell.v.trim() : undefined;
    if (!header || !COST_CATEGORIES.has(header)) {
      continue;
    }

    const grossHeaderCell = sheet[XLSX.utils.encode_cell({ r: range.s.r, c: col + 1 })];
    const grossHeader =
      typeof grossHeaderCell?.v === "string" ? grossHeaderCell.v.trim() : undefined;
    if (grossHeader?.toUpperCase() !== "BRUTTO") {
      continue;
    }

    const netHeaderCell = sheet[XLSX.utils.encode_cell({ r: range.s.r, c: col + 2 })];
    const hasNetColumn =
      typeof netHeaderCell?.v === "string" && netHeaderCell.v.trim().toUpperCase() === "NETTO";

    const entries: CostEntry[] = [];
    for (let row = range.s.r + 1; row <= range.e.r; row++) {
      const nameCell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
      const grossCell = sheet[XLSX.utils.encode_cell({ r: row, c: col + 1 })];
      const name = typeof nameCell?.v === "string" ? nameCell.v.trim() : undefined;
      const gross = typeof grossCell?.v === "number" ? grossCell.v : undefined;
      if (!name || gross === undefined) {
        continue;
      }
      const entry: CostEntry = { name, gross };
      if (hasNetColumn) {
        const netCell = sheet[XLSX.utils.encode_cell({ r: row, c: col + 2 })];
        if (typeof netCell?.v === "number") {
          entry.net = netCell.v;
        }
      }
      entries.push(entry);
    }

    result[header] = entries;
  }

  return result;
}

function main() {
  // `pnpm run extract:xlsx -- "MAJ 26"` forwards the literal "--" through to
  // this script's argv on some pnpm/tsx versions -- skip it if present.
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const sheetName = args[0];
  if (!sheetName) {
    console.error('Usage: pnpm run extract:xlsx -- "MAJ 26"');
    process.exitCode = 1;
    return;
  }

  const workbookPath = join(process.cwd(), "design", "ROZLICZENIE PARKOWA 2025.xlsx");
  // `XLSX.readFile` relies on Node-specific fs bindings that aren't attached
  // to the ESM build of this package -- read the buffer ourselves instead.
  const buffer = readFileSync(workbookPath);
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    console.error(
      `Sheet "${sheetName}" not found. Available sheets: ${workbook.SheetNames.join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  const extracted = extractCostEntries(sheet);

  const outDir = join(process.cwd(), "data", "comparison");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${slugify(sheetName)}.json`);
  writeFileSync(outPath, JSON.stringify(extracted, null, 2), "utf-8");

  console.log(`Extracted cost categories from "${sheetName}":`);
  for (const [category, entries] of Object.entries(extracted)) {
    const total = entries.reduce((sum, e) => sum + e.gross, 0);
    console.log(`  ${category}: ${entries.length} entries, ${total.toFixed(2)} total gross`);
  }
  console.log(`\nWrote ${outPath}`);
}

main();
