---
name: wipe_provider_einvoicing
summary: Wipe all of a provider's e-invoicing rows from a staging accounting_documents DB in one transaction
env: staging
access: write
tier: staging
lang: js
aliases: [cpe]
examples:
  - args: 646845
    note: preview the counts, type the id back, then yes
  - args: "--dry-run 646845"
    note: preview + print the SQL, write nothing
  - args: "-n eng-pierogi 646845"
    note: "another staging namespace; production is refused"
---
# wipe_provider_einvoicing

Wipe **all of a provider's e-invoicing data** in the `accounting_documents` DB,
**on staging only**. Keyed off a single integer `provider_id`.

## What it does

1. **Preview (read-only):** one `houston psql <ns> accounting_documents` query
   counts the rows that would be deleted, per table, and prints the total.
2. **Confirm:** you type the `provider_id` back, then `yes`.
3. **Wipe (`--write`):** runs the deletes as a **single transaction**
   (`psql -1 -v ON_ERROR_STOP=1 -f <tmp.sql>`) — any error rolls back everything,
   so there are no partial deletes.

Everything is driven off `provider_id` via subqueries; no id plumbing between
steps. Documents are matched by `provider_id` **or** their
`account_configuration_id` (covers migrated rows whose `provider_id` is null but
that still link through a config).

## Delete order (children → parents)

```
einvoicing_accounting_document_line_items   (by accounting_document_id)
e_invoice_compliance_records                (by accounting_document_id)
accounting_document_error_logs              (by accounting_document_id)
accounting_documents_logs                   (by accounting_document_id)
UPDATE accounting_documents.latest_tracker_id = NULL   (break self-ref)
e_invoice_trackers                          (by accounting_document_id)
accounting_documents                        (by provider_id / config)
einvoice_integration_issues                 (by plugin)
einvoice_integration_application_requests   (by config)
e_invoice_it_smart_receipts_configuration   (by plugin / provider_id)
account_configuration_plugins               (by config)
e_invoicing_configuration_logs              (by config)
account_configuration_addresses             (by config)
account_configurations                      (by provider_id)
```

## Out of scope (by design)

- The **`invoicing/` domain** (`invoice_parties` / `invoices` / `invoicing_periods`
  — Fresha periodic billing, keyed by `legal_entity_id`). Not touched.
- Rows keyed **only by `invoice_entity_id`** (this matches by `provider_id`).

## Safety

- **Staging only.** Refuses `--namespace production` / `prod`.
- Per-table count preview before any prompt.
- Requires typing the `provider_id` back, then `yes`.
- Single transaction — atomic; a mid-run error rolls back all deletes.
- `--dry-run` writes nothing.

## Prereqs

- VPN up; `houston` authenticated (staging psql uses the default
  `fresha-production-developer` profile, which can assume staging write access).
- Node on PATH. Dependency-free.
