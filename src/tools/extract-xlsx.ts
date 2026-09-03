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
import ExcelJS from "exceljs";

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

function extractCostEntries(sheet: ExcelJS.Worksheet): Record<string, CostEntry[]> {
  const result: Record<string, CostEntry[]> = {};
  const headerRow = 1;

  for (let col = 1; col <= sheet.columnCount; col++) {
    const headerCell = sheet.getRow(headerRow).getCell(col);
    const header = typeof headerCell.value === "string" ? headerCell.value.trim() : undefined;
    if (!header || !COST_CATEGORIES.has(header)) {
      continue;
    }

    const grossHeaderCell = sheet.getRow(headerRow).getCell(col + 1);
    const grossHeader =
      typeof grossHeaderCell.value === "string" ? grossHeaderCell.value.trim() : undefined;
    if (grossHeader?.toUpperCase() !== "BRUTTO") {
      continue;
    }

    const netHeaderCell = sheet.getRow(headerRow).getCell(col + 2);
    const hasNetColumn =
      typeof netHeaderCell.value === "string" &&
      netHeaderCell.value.trim().toUpperCase() === "NETTO";

    const entries: CostEntry[] = [];
    for (let row = 2; row <= sheet.rowCount; row++) {
      const nameCell = sheet.getRow(row).getCell(col);
      const grossCell = sheet.getRow(row).getCell(col + 1);
      const name = typeof nameCell.value === "string" ? nameCell.value.trim() : undefined;
      const gross = typeof grossCell.value === "number" ? grossCell.value : undefined;
      if (!name || gross === undefined) {
        continue;
      }
      const entry: CostEntry = { name, gross };
      if (hasNetColumn) {
        const netCell = sheet.getRow(row).getCell(col + 2);
        if (typeof netCell.value === "number") {
          entry.net = netCell.value;
        }
      }
      entries.push(entry);
    }

    result[header] = entries;
  }

  return result;
}

async function main() {
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
  const workbook = new ExcelJS.Workbook();
  // exceljs's own .d.ts declares a module-local `Buffer extends ArrayBuffer`
  // shadow type for this signature, distinct from (and incompatible with)
  // @types/node's real Buffer -- there's no way to reference that shadow
  // type by name from here, so cast through `any` to satisfy it; the runtime
  // value is an ordinary Node Buffer and is unaffected.
  // biome-ignore lint/suspicious/noExplicitAny: see comment above
  await workbook.xlsx.load(buffer as any);
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) {
    console.error(
      `Sheet "${sheetName}" not found. Available sheets: ${workbook.worksheets.map((ws) => ws.name).join(", ")}`,
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
