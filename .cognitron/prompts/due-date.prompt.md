Analyze @design/INVOICE_HEADER_FIELDS_PLAN.md. Understand the internals.
I want to enrich invoices table with some more attributes. In this iteration, I would like you to add:
-  net_total, vat_total
- payment_due_date

The first goal is to have the tables modified and populated with data extracted from raw xmls. I want to be able to export the data with new attributes to verify. 
For this reason, I will need to update scripts/export-invoices.py as the next step.
The UI is to be addressed only after those.
Don't target UI implementation (new attributes visualisation yet).

Remember to use subagents during your analysis (see AGENTS.md and CLAUDE.md). 
Please, confirm you understand my request. Ask clarifying questions if needed. Present your plan as you would approach this problem. When I agree, I will give you a go.