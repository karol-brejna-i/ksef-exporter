# KSeF Integration Reference

*Created: 2026-08-23 11:45 CEST · Updated: 2026-08-23 13:27 CEST*

A self-contained orientation document for agents that need to understand how this
repository talks to KSeF (Krajowy System e-Faktur, Poland's national e-invoicing
system), and where the authoritative external documentation lives.

Read this before touching anything under `src/ksef/`, `src/sync.ts`, or the
continuation-point logic. It summarises the mechanics; the linked sources remain
authoritative when they disagree with this file.

---

## 1. Quick facts

| Question           | Answer                                                                          |
| ------------------ | ------------------------------------------------------------------------------- |
| Target system      | KSeF 2.0 API                                                                    |
| SDK used here      | `ksef-client` (npm), pinned `^0.7.1` in [package.json](package.json)            |
| SDK repository     | https://github.com/smekcio/ksef-client-typescript                               |
| SDK last published | `0.7.1`, npm `modified` 2026-08-05; repo `pushed_at` 2026-08-05                 |
| SDK provenance     | Community, single-maintainer, MIT — **not** an official Ministry of Finance SDK |
| Official API docs  | https://github.com/CIRFMF/ksef-api                                              |
| Access level       | Read-only — a KSeF token scoped to `InvoiceRead`, never issuing                 |
| Directions used    | Purchases (`Subject2`) and sales (`Subject1`), one per sync call               |
| Environments       | `TEST`, `DEMO`, `PRD` — selected by `KSEF_ENVIRONMENT`                          |
| Test API base      | `https://api-test.ksef.mf.gov.pl`                                               |

Neither restriction comes from the SDK. `ksef-client` types `subjectType` as a bare
`string` and fully supports issuing invoices; read-only and the choice of directions
are this application's decisions.

---

## 2. Where the authoritative documentation lives

### 2.1 Official (Ministry of Finance / CIRF)

`CIRFMF` is the Ministry of Finance's public GitHub organisation. It is the
primary source of truth for API mechanics, XSD schemas, and limits.

| Topic                          | Link                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| API documentation root         | https://github.com/CIRFMF/ksef-api                                                              |
| OpenAPI definition             | https://github.com/CIRFMF/ksef-api/blob/main/open-api.json                                      |
| API changelog                  | https://github.com/CIRFMF/ksef-api/blob/main/api-changelog.md                                   |
| Key 2.0 changes overview       | https://github.com/CIRFMF/ksef-api/blob/main/przeglad-kluczowych-zmian-ksef-api-2-0.md          |
| Environments                   | https://github.com/CIRFMF/ksef-api/blob/main/srodowiska.md                                      |
| Authentication                 | https://github.com/CIRFMF/ksef-api/blob/main/uwierzytelnianie.md                                |
| KSeF tokens                    | https://github.com/CIRFMF/ksef-api/blob/main/tokeny-ksef.md                                     |
| Permissions model              | https://github.com/CIRFMF/ksef-api/blob/main/uprawnienia.md                                     |
| Encryption public keys         | https://github.com/CIRFMF/ksef-api/blob/main/bezpieczenstwo/klucze-publiczne-do-szyfrowania.md  |
| Invoice download (overview)    | https://github.com/CIRFMF/ksef-api/blob/main/pobieranie-faktur/pobieranie-faktur.md             |
| **Incremental download**       | https://github.com/CIRFMF/ksef-api/blob/main/pobieranie-faktur/przyrostowe-pobieranie-faktur.md |
| **High-water-mark (HWM)**      | https://github.com/CIRFMF/ksef-api/blob/main/pobieranie-faktur/hwm.md                           |
| **Rate limits (per endpoint)** | https://github.com/CIRFMF/ksef-api/blob/main/limity/limity-api.md                               |
| General limits                 | https://github.com/CIRFMF/ksef-api/blob/main/limity/limity.md                                   |
| KSeF number format             | https://github.com/CIRFMF/ksef-api/blob/main/faktury/numer-ksef.md                              |
| Invoice verification           | https://github.com/CIRFMF/ksef-api/blob/main/faktury/weryfikacja-faktury.md                     |
| Test data / scenarios          | https://github.com/CIRFMF/ksef-api/blob/main/dane-testowe-scenariusze.md                        |

### 2.2 XSD schemas (data types)

| Schema                   | Link                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| FA(3) invoice — current  | https://github.com/CIRFMF/ksef-api/blob/main/faktury/schemy/FA/schemat_FA(3)_v1-0E.xsd     |
| FA(2) invoice — legacy   | https://github.com/CIRFMF/ksef-api/blob/main/faktury/schemy/FA/schemat_FA(2)_v1-0E.xsd     |
| FA base types (`bazowe`) | https://github.com/CIRFMF/ksef-api/tree/main/faktury/schemy/FA/bazowe                      |
| PEF / RR schemas         | https://github.com/CIRFMF/ksef-api/tree/main/faktury/schemy                                |
| Auth schemas             | https://github.com/CIRFMF/ksef-api/tree/main/auth/schemy (`schemat_auth_v2-0.xsd`, `v2-1`) |
| UPO schemas              | https://github.com/CIRFMF/ksef-api/tree/main/faktury/upo                                   |

**FA(3) is also vendored locally** by the SDK, which is usually faster to grep
than fetching from GitHub:

```
node_modules/ksef-client/dist/documents/fa3/schemas/schemat_FA(3)_v1-0E.xsd
node_modules/ksef-client/dist/documents/fa3/schemas/bazowe/
```

### 2.3 Official reference clients (useful for semantics)

Neither is used here, but both are Ministry-published and are the best
cross-check when the TypeScript SDK's behaviour is ambiguous:

- C#: https://github.com/CIRFMF/ksef-client-csharp
- PDF generator: https://github.com/CIRFMF/ksef-pdf-generator

### 2.4 The SDK actually used here

- Repo: https://github.com/smekcio/ksef-client-typescript
- npm: https://www.npmjs.com/package/ksef-client
- Changelog: https://github.com/smekcio/ksef-client-typescript/blob/main/CHANGELOG.md
- Issues: https://github.com/smekcio/ksef-client-typescript/issues

Treat it as a small community project: pin exact versions, read the diff before
upgrading, be prepared to work around bugs locally.

---

## 3. Domain vocabulary

| Term                            | Meaning                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **KSeF number**                 | The system-assigned unique invoice identifier. The deduplication key in this app.                                |
| **Subject1 / Subject2**         | Roles on an invoice. `Subject1` = seller (sales), `Subject2` = buyer (purchases). The same document is both, depending on who asks — direction is not in the XML. |
| **FA(2) / FA(3)**               | Versions of the invoice XML logical structure. Field codes (`P_1`, `P_2`, `P_15`, …) are stable across versions. |
| **PermanentStorage date**       | The date on which KSeF durably stored the invoice. The only date type safe for incremental sync.                 |
| **HWM** (high-water mark)       | The timestamp up to which KSeF guarantees the data set is complete.                                              |
| **Continuation point**          | An opaque KSeF token marking where the next incremental fetch resumes.                                           |
| **UPO**                         | The official confirmation-of-receipt document. Issuing-side concept; unused here.                                |
| **Session (interactive/batch)** | Invoice *submission* modes. Issuing-side; unused here.                                                           |

---

## 4. Authentication mechanics

Two phases: a one-time human setup, then a fully automated runtime loop.

### 4.1 One-time human setup (outside the app)

1. An authorised person logs into the KSeF Taxpayer App / e-Urząd Skarbowy
   (Trusted Profile, e-Dowód, or e-banking).
2. Under "Uprawnienia" / "Tokeny", generates a **KSeF Token** scoped to exactly
   `InvoiceRead`. No issuing permissions, ever.
3. The token goes into the backend environment as `KSEF_TOKEN` and is treated as
   a password-grade secret.

The token is immutable once issued. Changing scope means issuing a new token and
revoking the old one (`DELETE /tokens/{referenceNumber}`).

### 4.2 Automated runtime flow

```
POST /auth/challenge                 -> { challenge, timestamp }   (valid 10 min)
  encrypt "{ksefToken}|{timestampMs}" with RSA-OAEP (SHA-256/MGF1), base64
POST /auth/ksef-token                -> authenticationToken (JWT) + referenceNumber
GET  /auth/{referenceNumber}         -> poll until success        (bearer: authenticationToken)
POST /auth/token/redeem              -> accessToken (minutes) + refreshToken (<= 7 days)
POST /auth/token/refresh             -> new accessToken           (bearer: refreshToken)
```

When the refresh token itself expires, restart from `/auth/challenge` using the
stored KSeF token. No human involvement.

### 4.3 How this repo does it

`KsefClient.connect()` implements the entire flow above; the SDK's `AuthManager`
transparently refreshes the access token. The only thing this repo adds is
recovery when the *refresh* token has died:

- [src/ksef/client.ts](src/ksef/client.ts) — `KsefSessionManager` caches one
  lazily-created session and, on `KsefSessionExpiredError`, re-runs the full auth
  flow exactly once.

Never log tokens, JWTs, or challenge payloads.

---

## 5. Invoice retrieval mechanics (the part that matters here)

KSeF's supported way to mirror invoices into an external system is **incremental
export**, not per-invoice polling.

### 5.1 The raw API cycle

1. `POST /invoices/exports` — starts an async export job:
   - `filters.subjectType` — `"Subject2"` (buyer → purchases) or `"Subject1"`
     (seller → sales). One direction per export, each with its own continuation point.
   - `filters.dateRange = { dateType: "PermanentStorage", from, to, restrictToPermanentStorageHwmDate: true }`
   - `encryption` — client-generated AES-256 key/IV, RSA-encrypted for KSeF.
2. `GET /invoices/exports/{referenceNumber}` — poll until complete. The response
   carries encrypted ZIP part URLs plus:
   - `isTruncated` — the job hit size/count limits before covering the range,
   - `permanentStorageHwmDate` — completeness guarantee point,
   - `lastPermanentStorageDate` — set only when truncated.
3. Download parts → decrypt with the AES key/IV → concatenate → unzip. The
   archive holds invoice XML files plus `_metadata.json` (KSeF numbers, used for
   dedup).
4. Parse each XML into a flat record.

**`dateType` must be `PermanentStorage` for incremental sync.** `Issue` and
`Invoicing` dates are subject to asynchronous ingestion delay, so a window keyed
on them can silently skip or duplicate invoices.

### 5.2 Continuation (high-water-mark) rules

- Windows must be **contiguous**: the next `from` is the previous window's
  effective end. Deduplication is a safety net, not a design assumption.
- Next window start: `lastPermanentStorageDate` when `isTruncated`, otherwise
  `permanentStorageHwmDate`.
- Deduplicate on KSeF number.
- Persist the continuation state per subject type across runs.

### 5.3 How this repo does it

- [src/ksef/invoices.ts](src/ksef/invoices.ts) — thin adapter over
  `client.workflows.exportsIncremental.run()`, which already performs
  start → poll → download → decrypt → unzip → dedupe → HWM advance. Passes
  `requireExportPartHash: true`.
- [src/sync.ts](src/sync.ts) — the engine: fetch → idempotent persist →
  categorize → extract line items, plus continuation bookkeeping and structured
  `sync.*` logging.
- [src/ksef/invoice-parser.ts](src/ksef/invoice-parser.ts) — FA(2)/FA(3) XML →
  flat records, via `fast-xml-parser`. The SDK's FA(3) builders are for
  *constructing outbound* invoices and are not used for inbound parsing.
- [src/ksef/rate-limit.ts](src/ksef/rate-limit.ts) — bounded, redacting error
  classification (`classifyKsefError`) so diagnostics never carry payloads.

---

## 6. Rate limits — the sharp edge

`POST /invoices/exports` is the tightest limit in the entire API:

| Endpoint                      | Limits                                    |
| ----------------------------- | ----------------------------------------- |
| `POST /invoices/exports`      | **8/s, 16/min, 20/hour** per subject type |
| `GET /invoices/exports/{ref}` | 10/s, 60/min, 600/hour                    |

Full table: https://github.com/CIRFMF/ksef-api/blob/main/limity/limity-api.md

Consequences that have already caused a production incident here:

- The SDK's `exportsIncremental.run()` defaults to `maxIterations: 20` and issues
  **one export-init request per iteration**. A single wide-window sync can burn
  the whole hourly budget in seconds.
- The SDK does **not** auto-retry on `429`; it throws `KsefRateLimitError`. Since
  `run()` returns only at the end of its loop, a mid-loop `429` discarded every
  invoice already fetched in that call.
- Therefore `syncPurchaseInvoices` defaults `maxIterations` to **1**. Do not
  raise it casually. If more data remains, `hasMore` is surfaced and the human
  triggers another sync.
- On `429`, honour `Retry-After`. It is a server-side quota; there is nothing to
  bypass client-side.

Other documented ceilings: invoice max 1 MB (3 MB with attachment), max 10,000
invoices per session.

---

## 7. Temporal data — three different kinds

This is the single most error-prone area of the integration. Conflating these
produces off-by-one-day and off-by-hours bugs that are invisible in tests written
by the same misunderstanding.

| Kind                                   | Examples                                                   | Storage                |
| -------------------------------------- | ---------------------------------------------------------- | ---------------------- |
| **Civil date** (calendar day, no zone) | `issue_date`, `delivery_date`, `window_from`, `window_to`  | `TEXT` `YYYY-MM-DD`    |
| **Instant** (a moment)                 | `created_at`, `requested_at`, `started_at`, `completed_at` | `INTEGER` epoch **ms** |
| **Opaque KSeF token**                  | `continuation_point` and its `sync_runs` copies            | verbatim `TEXT`        |

Rules:

- A continuation point *looks* like a timestamp but its contract is
  byte-identical round-trip to KSeF, including microseconds and explicit offset.
  Persist it exactly as received.
- **Never compare temporal values lexicographically.** ISO-8601 string order is
  not chronological once offsets differ (`+02:00` sorts above `+00:00` yet is two
  hours earlier). Parse to epoch ms and compare numerically —
  see `continuationPointToEpochMs` in [src/time.ts](src/time.ts).
- `windowFrom` / `windowTo` are **inclusive civil dates**. Compare an instant
  against the exclusive start of the day *after* `windowTo`.
- Never convert a civil date into an instant; that invents a timezone.

---

## 8. Data mapping

Parsed from the invoice XML (field codes stable across FA(2)/FA(3)):

| Concept         | XML path                                                                       |
| --------------- | ------------------------------------------------------------------------------ |
| Seller identity | `Faktura/Podmiot1/DaneIdentyfikacyjne/{NIP,Nazwa}`                             |
| Buyer identity  | `Faktura/Podmiot2/DaneIdentyfikacyjne/{NIP,Nazwa}`                             |
| Invoice number  | `Faktura/Fa/P_2`                                                               |
| Issue date      | `Faktura/Fa/P_1`                                                               |
| Gross total     | `Faktura/Fa/P_15`                                                              |
| Currency        | `Faktura/Fa/KodWaluty`                                                         |
| Line items      | `Faktura/Fa/FaWiersz` (`P_7` name, `P_8B` qty, `P_11` net, `P_12` VAT rate, …) |

Notes that only show up in real data:

- `P_12` (VAT rate) is **text, never numeric**: `zw`, `oo`, `np I`, `0 WDT`, …
- Correction invoices (`RodzajFaktury = KOR`) emit each line twice — once with
  `StanPrzed` and once without — repeating `NrWierszaFa`. Line identity is
  therefore document-order `ordinal`, not the issuer's line number.
- Raw XML is retained per invoice for audit and for deriving line items later
  without new KSeF calls.

---

## 9. Invariants for this application

- Purchases (`Subject2`) and sales (`Subject1`), one direction per sync call, each
  with its own continuation point; `PermanentStorage` for incremental sync.
- Sales invoices are never categorized: `category_id = NULL`,
  `categorization_confidence = "not_applicable"`, and they must never reach the
  correction path.
- KSeF access is **read-only**. Never add issuing permissions.
- Never log KSeF tokens, JWTs, raw SDK response bodies, or invoice XML.
- Invoices deduplicate by KSeF number; re-syncing must never overwrite a
  human-assigned category.
- Every sync persists its continuation point and writes a `sync_runs` audit row,
  on both success and failure.
- Unit tests must never make real KSeF network calls — inject or mock the client.

---

## 10. Where to look next in this repo

| You need                                        | File                                                                                                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product requirements + KSeF mechanics narrative | [design/SPEC.md](design/SPEC.md) §3                                                                                                                                              |
| Phase status / what is implemented              | [design/IMPLEMENTATION_PLAN.md](design/IMPLEMENTATION_PLAN.md)                                                                                                                   |
| Import logging, diagnostics, traceability       | [design/IMPORT_OBSERVABILITY_PLAN.md](design/IMPORT_OBSERVABILITY_PLAN.md)                                                                                                       |
| Line-item workstream                            | [design/INVOICE_ITEMS_PLAN.md](design/INVOICE_ITEMS_PLAN.md)                                                                                                                     |
| Invoice direction / sales ingestion             | [design/SALES_INVOICES_PLAN.md](design/SALES_INVOICES_PLAN.md)                                                                                                                   |
| Column types, migrations, temporal values       | [design/SCHEMA_TYPES_PLAN.md](design/SCHEMA_TYPES_PLAN.md)                                                                                                                       |
| Continuation-point failure post-mortems         | [design/SYNC_CONTINUATION_POINT_ANALYSIS.md](design/SYNC_CONTINUATION_POINT_ANALYSIS.md), [design/SYNC_CONTINUATION_STRIKES_AGAIN.md](design/SYNC_CONTINUATION_STRIKES_AGAIN.md) |
| Invoice type findings from real data            | [design/INVOICE_TYPES_ANALYSIS.md](design/INVOICE_TYPES_ANALYSIS.md)                                                                                                             |

Manual probes (require real credentials, hit the live API — use deliberately):

```
pnpm run smoke:ksef        # src/ksef/smoke.ts
pnpm run smoke:invoices    # src/ksef/smoke-invoices.ts
pnpm run dump:invoices     # src/ksef/dump-invoices.ts
```

---

## 11. SDK surface cheat-sheet (`ksef-client@0.7.1`)

Entry point: `KsefClient.connect(options)` → `Promise<KsefClient>`.

```ts
connect({
  environment: "TEST" | "DEMO" | "PRD",
  token: "<KSeF token>",
  context: { type: "Nip", value: "<10-digit NIP>" },
})
```

Resource clients: `auth`, `security`, `sessions`, `invoices`, `permissions`,
`certificates`, `tokens`, `limits`, `testdata`, `collectiveIdentifiers`,
`peppol`, `lighthouse`, `activeSessions`.

Workflows (`client.workflows`): `auth`, `sessions.online`, `sessions.batch`,
`offline`, `exports`, **`exportsIncremental`** ← the only one this app uses.

Also: `authManager` (token lifecycle), `verificationLinks`, `qr`, `personToken`.

Errors worth catching by type: `KsefSessionExpiredError`, `KsefRateLimitError`
(`retryAfterSeconds`), `KsefApiError` (`statusCode`, `problem`).

Subpath exports: `ksef-client`, `ksef-client/documents/fa3`, `ksef-client/cli`.

Optional peer dependencies, only needed for features this app does not use:
`qrcode` (QR codes), `node-forge` (XAdES from PKCS12), `libxmljs2` (FA(3) XSD
validation — Node 24 prebuilds only, loaded lazily, inert here).
