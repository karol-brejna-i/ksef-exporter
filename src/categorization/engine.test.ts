import { describe, expect, it } from "vitest";
import type { CategorizationRule } from "../db/rules.js";
import { categorize } from "./engine.js";

const MEDIA_ID = 1;
const ZAKUP_TOWAROW_ID = 2;
const INNE_ID = 3;

const RULES: CategorizationRule[] = [
  { id: 1, matchType: "seller_nip", matchValue: "5265877635", categoryId: MEDIA_ID },
  { id: 2, matchType: "seller_name_contains", matchValue: "energa", categoryId: MEDIA_ID },
  {
    id: 3,
    matchType: "seller_name_contains",
    matchValue: "eurocash",
    categoryId: ZAKUP_TOWAROW_ID,
  },
  { id: 4, matchType: "seller_name_contains", matchValue: "obi", categoryId: INNE_ID },
];

describe("categorize", () => {
  it("matches on exact seller NIP", () => {
    const result = categorize({ sellerNip: "5265877635", sellerName: "Some Random Name" }, RULES);
    expect(result).toEqual({ categoryId: MEDIA_ID, confidence: "matched" });
  });

  it("falls back to a case-insensitive seller-name substring match", () => {
    const result = categorize({ sellerNip: "9999999999", sellerName: "Energa Obrót S.A." }, RULES);
    expect(result).toEqual({ categoryId: MEDIA_ID, confidence: "matched" });
  });

  it("matches seller-name rules regardless of casing on either side", () => {
    const result = categorize({ sellerNip: null, sellerName: "EUROCASH DYSTRYBUCJA" }, RULES);
    expect(result).toEqual({ categoryId: ZAKUP_TOWAROW_ID, confidence: "matched" });
  });

  it("flags an invoice matching no rule as needs_review, not a silent guess", () => {
    const result = categorize(
      { sellerNip: "1234567890", sellerName: "Unknown Vendor Sp. z o.o." },
      RULES,
    );
    expect(result).toEqual({ categoryId: null, confidence: "needs_review" });
  });

  it("prefers a NIP match over a name-based rule when both could apply", () => {
    // "Energa" would match the name rule, but the NIP rule for this exact
    // seller must win (SPEC §4: NIP is the preferred, stable identifier).
    const rulesWithConflict: CategorizationRule[] = [
      ...RULES,
      { id: 5, matchType: "seller_name_contains", matchValue: "energa", categoryId: INNE_ID },
    ];
    const result = categorize(
      { sellerNip: "5265877635", sellerName: "Energa Obrót S.A." },
      rulesWithConflict,
    );
    expect(result).toEqual({ categoryId: MEDIA_ID, confidence: "matched" });
  });

  it("is a pure function: same inputs always produce the same output", () => {
    const invoice = { sellerNip: "5265877635", sellerName: "Energa Obrót S.A." };
    const first = categorize(invoice, RULES);
    const second = categorize(invoice, RULES);
    expect(first).toEqual(second);
  });

  it("does not throw or match when sellerNip is null and no name rule applies", () => {
    const result = categorize({ sellerNip: null, sellerName: "Totally Unrelated" }, RULES);
    expect(result).toEqual({ categoryId: null, confidence: "needs_review" });
  });
});
