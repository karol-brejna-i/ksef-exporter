The system specification and implementation plan (including progress) are both documented in `design/IMPLEMENTATION_PLAN.md`.

Before proceeding, run this pre-check:
1. Verify `design/IMPLEMENTATION_PLAN.md` is readable.
2. Verify it has sufficient detail about invoice import and persistence.
3. Verify `data/ksef-exporter.sqlite` is readable.
If any check fails, stop and report which check failed before continuing.

We have many features implemented already. One of those featues is importing invoices. 

Right now we store the imported invoices in a database.

The web module is presenting a list of invoices. It is very simple UI (prototype).

Currently, we don't have a structure to persist and present the information about invoice items. We only have a structure to persist and present the information about invoices. On the other hand, the imported data include all details for each invoice, including invoice items -- in XML format.

Inspect and query `data/ksef-exporter.sqlite` to examine the database schema and the data persisted so far. If you cannot access or query this database file, stop and notify me before proceeding, similar to the specification file requirement.
Particularly, the XML is stored in `invoices.raw_xml` (an example raw XML is copied to `data/example.invoice.xml`). If `data/example.invoice.xml` is missing or its structure doesn't match samples from `invoices.raw_xml`, note this discrepancy explicitly in the output document and rely on database samples instead. Sample at least 10 invoices with different `raw_xml` structures (or all if fewer than 10 exist) to identify schema variations before drawing conclusions. Note any inconsistencies, missing data, or schema variations across different invoices' `raw_xml`, and address how the implementation plan should handle malformed or incomplete XML.

Delegate to subagents only for: (a) mechanical tasks such as running SQL queries, listing files, or reading XML samples (use Haiku), or (b) generating boilerplate sections of the output document (use Sonnet). Perform all analysis, schema design, migration planning, and final document writing yourself. For complex reasoning such as designing the new schema and migration steps, use Opus.

Produce a single self-contained markdown document that captures: (1) a summary of the current database schema, the structure of the XML in raw_xml, and the gap in invoice item persistence, (2) a step-by-step implementation plan to add invoice item storage and display. This document will be used as context for further work with AI coding agents.