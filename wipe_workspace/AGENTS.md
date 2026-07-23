# wipe_workspace

Deletes the **accounting-documents / e-invoicing** data for one workspace (`provider_id`)
from the `accounting-documents` DB. Staging only.

## Scope

The workspace key is `account_configurations.provider_id`. This wipes only the cluster
reachable from it:

```
account_configurations (provider_id)
├─ account_configuration_addresses
├─ account_configuration_plugins            (+ cascades from account_configurations)
│  ├─ e_invoice_it_smart_receipts_configuration
│  ├─ einvoice_integration_issues
│  └─ einvoice_integration_application_requests
├─ e_invoicing_configuration_logs
├─ einvoice_integration_application_requests
└─ accounting_documents
   ├─ accounting_document_error_logs
   ├─ accounting_documents_logs
   ├─ e_invoice_compliance_records
   ├─ e_invoice_trackers                     (accounting_documents.latest_tracker_id -> SET NULL)
   └─ einvoicing_accounting_document_line_items
```

**NOT touched:** the `invoices` / `invoice_*` cluster (no `provider_id`; linked via
`invoice_parties.external_id`, buyer parties are shared) and global tables
(`comarch_jwt_tokens`, `e_invoice_unmatched_compliance_records`, `oban_*`, `outbox_events`).

## Why one big statement

`wipe.sql` deletes everything in a single statement of data-modifying CTEs. All CTEs share
one snapshot and every FK check fires at statement end, so the CTE order is irrelevant —
but **every** referencing table must be present or the whole statement aborts. If you add a
new table with an FK into this cluster, add its `DELETE` here too.

## Run

```bash
# 1. Preview (read-only, NO --write) — eyeball the counts first:
houston psql eng-orion accounting-documents -- -v pid=<PROVIDER_ID> -f preview.sql

# 2. Wipe (atomic transaction, --write):
houston psql eng-orion accounting-documents --write -- -v pid=<PROVIDER_ID> -f wipe.sql
```

To test the wipe without persisting, edit `wipe.sql` and change the final `COMMIT;` to
`ROLLBACK;` — it runs the whole thing, prints the verify counts, then throws it away.
