---
name: backfill_missing_documents
summary: "Backfill invoices and credit notes for sales that never produced one: export CSV, upload to S3, run the task"
env: production
access: write
tier: prod-write
lang: exs
examples:
  - args: ""
    note: prompts for provider_id and sale ids
  - args: 646845 123,456,789
    note: prompts before each step
  - args: 646845 123,456 --dry-run
    note: export + upload, print the task command, don't run it
  - args: 646845 123,456 --skip-upload
    note: only build the CSV locally
---
# backfill_missing_documents

Backfill accounting documents (invoices / credit notes) for sales that never
produced one. Drives the `process_missing_sales_events` houston task in
`app-accounting-documents`.

## Pipeline

1. **Export** — `houston psql production shedul` runs a `\copy` that dumps the
   given sales to a local CSV. Filtered by `provider_id` + an explicit list of
   sale ids (no date range).
2. **Upload** — `houston aws-shell <profile> -- aws s3 cp` puts the CSV in
   `s3://fresha-accounting-documents-production/process_missing_sales_events_backfill/`.
3. **Task** — `houston task run accounting-documents-web process_missing_sales_events`
   with `-p PROVIDER_ID=… -p S3_KEY=… [-p FORCE=true] -w`. **Gated** behind a
   typed `yes` confirmation.

## Skip-if-exists

The task runs with `FORCE` unset — its `InvoiceProcessingRouter.redirect/2`
calls `BillingDocumentValidator.exists?` and **skips** any sale that already
has a document (logs `... already exists`, returns `:ok`). This script never
sends `FORCE`, so existing documents are always left untouched.

## CSV contract — DO NOT reorder

The SELECT column order is dictated by the task parser
`ProcessMissingSalesEventsTask.parse_row/1` (32 columns: s, si, sit, asc, asct,
os, rfs). The task filters rows again by `provider_id` and requires the S3 key
to **contain** the provider id — the generated filename `<provider>_<stamp>.csv`
satisfies this.

Bucket comes from the task's app config `:accounting_documents_bucket`
(`AWS_S3_ACCOUNTING_DOCUMENTS_BUCKET` = `fresha-accounting-documents-production`
in prod).

## Flags

| Flag | Effect |
|------|--------|
| `--profile <name>` | AWS profile for the upload. Default `fresha-production-team-orion` (has `s3:PutObject` on the bucket; `fresha-production-developer` does not). |
| `--keep-csv` | Keep the generated CSV (prints its path). |
| `--dry-run` | Export + upload, print the task command, skip running it. |
| `--skip-upload` | Only build the CSV (implies `--dry-run`, `--keep-csv`). |
| `-h`, `--help` | Full help. |

## Prereqs

- Elixir on PATH (script is `backfill_missing_documents.exs`; no external deps, so no
  `Mix.install` — starts instantly).
- VPN + `houston` auth (production-developer profile for the psql read + S3
  upload).
- `aws` CLI on PATH (used inside `houston aws-shell`).
