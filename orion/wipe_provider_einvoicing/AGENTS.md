---
name: wipe_provider_einvoicing
summary: Wipe all of a provider's e-invoicing rows from a staging accounting_documents DB in one transaction
domain: e-invoicing
env: staging
access: write
tier: staging
lang: js
examples:
  - args: ""
    note: asks for the provider_id and whether to dry run
  - args: 12345
    note: asks only whether to dry run (true is preselected)
  - args: "--dry-run true 12345"
    note: preview the counts + print the SQL, write nothing
  - args: "--namespace eng-devex --dry-run false 12345"
    note: "another staging namespace; wipes after a typed yes. Production is refused"
---
# wipe_provider_einvoicing

Wipe **all of a provider's e-invoicing data** in the `accounting_documents` DB,
**on staging only**. Keyed off a single integer `provider_id`.

## What it does

On a terminal it asks for what the flags left out: the `provider_id` (typed), then
whether to dry run (a picker, `true` preselected). It never asks for the
environment — it runs on staging only, and its banner names staging and the
namespace. Without a terminal it asks nothing: the `provider_id` must be given and
the run is a dry run.

1. **Preview (read-only):** one `houston psql <ns> accounting_documents` query
   counts the rows that would be deleted, per table, and prints the total. A dry
   run prints the delete SQL and stops here.
2. **Confirm:** with dry run `false`, you type `yes`.
3. **Wipe (`--write`):** runs the deletes as a **single transaction**
   (`BEGIN`/`COMMIT` in the SQL file, `psql -v ON_ERROR_STOP=1 -f <tmp.sql>`) — any
   error rolls back everything, so there are no partial deletes.

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
- Per-table count preview before the confirmation.
- Dry run unless you pick `false` (or pass `--dry-run false`); the wipe then
  needs a typed `yes`. Without a terminal it is always a dry run, and
  `--dry-run false` exits 2.
- Single transaction — atomic; a mid-run error rolls back all deletes.

## Prereqs

- VPN up; `houston` authenticated (staging psql uses the default
  `fresha-production-developer` profile, which can assume staging write access).
- Node on PATH. Dependency-free.
