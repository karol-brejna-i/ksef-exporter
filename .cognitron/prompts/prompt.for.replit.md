# Replit prompt — invoice UI prototype

Build a UI prototype (frontend only, mock data is fine — no real backend/auth needed) for browsing purchase invoices imported from a Polish e-invoicing system (KSeF). This is a design exploration for a better UI on an existing working app, so focus on layout, information hierarchy, and interaction — not backend correctness.

## Domain model

An *Invoice* has: issue date, seller name, seller NIP (tax id), buyer name, buyer NIP (buyer fields are often empty), invoice number, KSeF number (present only for invoices imported from KSeF; absent for manually-entered invoices, which instead show a "Manual" badge), gross total + currency, a category (e.g. "Media", "Zakup towarów", "Inne"), and a category confidence state: `matched` (auto-assigned with high confidence) or `needs review` (should stand out visually and invite the user to confirm/correct it). Each invoice has zero or more *line items*; it also tracks whether item extraction has run yet, so an invoice can be in one of three item-states: "not yet extracted", "extracted, 0 items", or "extracted, N items" — these three should look different, not collapse into a blank table.

A *line item* has: ordinal/position, description, quantity, unit (raw string, e.g. "szt.", "kg" — don't normalize/validate it), unit price (net or gross — net is sometimes missing, fall back to gross), net value, gross value, VAT rate (this is a label, not a plain percentage — values like `23`, `8`, `0 WDT`, `zw` (exempt), `oo` (reverse charge) all occur and should render as-is, not as "23%"), and VAT amount. A line item can be flagged as a "correction — state before" row (from a correcting invoice); style these as visually distinct/muted, not deleted.

Generate ~15-20 mock invoices with realistic Polish company names/NIPs, a mix of categories and confidence states, a couple of manual entries, a couple with "not yet extracted" items, and 3-8 line items each on the rest (with varied VAT rates and one correction example).

## Screen 1 — Invoice list

Dense, scannable table/list. Show only: issue date, seller name, gross total + currency, category (inline-editable, e.g. a dropdown), a small confidence indicator next to category, and an item-count affordance (expandable or a badge like "12 items" / "not extracted" / "no items"). Do NOT show buyer info, invoice number, KSeF number, or any line-item financial breakdown in this list — keep it uncluttered enough to scan 20+ rows at once. Include a small summary bar above the list (total count, count needing review, total gross per currency).

## Screen 2 — Invoice detail

Opens from a list row (modal, side panel, or dedicated view — your call). Header section: seller name + NIP, buyer name + NIP (hide gracefully if empty), invoice number, KSeF number or "Manual" badge, issue date, gross total, and the editable category + confidence badge (add a small inline note that correcting the category here will also apply to this seller's future invoices). Below that, a line-items table: #, description, quantity + unit, unit price, net value, gross value, VAT rate, VAT amount. Put everything else — product codes, delivery date, discount, exchange rate, raw source data — behind a collapsed "advanced details" section so it doesn't compete with the primary info.

Keep the visual style clean and functional — this is a finance/back-office tool, not a marketing site. Prioritize information density done well over decoration.
