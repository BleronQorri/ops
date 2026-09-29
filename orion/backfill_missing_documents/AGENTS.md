---
name: backfill_missing_documents
summary: "Backfill invoices and credit notes for sales that never produced one: export CSV, upload to S3, run the task"
domain: accounting-documents
env: production
access: write
tier: prod-write
lang: exs
examples:
  - args: ""
    note: asks whether to dry run, then for provider_id and the sale ids
  - args: 646845 123,456 --dry-run true
    note: export + upload (confirmed twice), print the task command, don't run it
  - args: 646845 123,456 --dry-run false
    note: export, upload, run the task, each write confirmed twice
  - args: 646845 123,456 --skip-upload
    note: only build the CSV locally
---
# backfill_missing_documents

Backfill accounting documents (invoices / credit notes) for sales that never
produced one. Drives the `process_missing_sales_events` houston task in
`app-accounting-documents`.

Production only — the production shedul database, the production bucket and the
production task — so it never asks for an environment and its banner says
PRODUCTION.

## Pipeline

1. **Export** — `houston psql production shedul` runs a `\copy` that dumps the
   given sales to a local CSV. Filtered by `provider_id` + an explicit list of
   sale ids (no date range). A read: on a terminal it asks `y` first, as it
   always has.
2. **Upload** — `houston aws-shell <profile> -- aws s3 cp` puts the CSV in
   `s3://fresha-accounting-documents-production/process_missing_sales_events_backfill/`.
   A production write, made in a dry run too.
3. **Task** — `houston task run accounting-documents-web process_missing_sales_events`
   with `-p PROVIDER_ID=… -p S3_KEY=… -w`. Only with `--dry-run false`.

## Asking and confirming

On a terminal it asks for what the arguments left out: **dry run** first (a
picker, `true` preselected), then `provider_id` and the sale ids as typed lines.
`--dry-run true` (or a bare `--dry-run`) keeps its old meaning: export and
upload, print the task command, run no task. `--dry-run false` also runs the
task.

Each write — the upload and the task — is confirmed by typing `yes`, then again
by typing `production`. Either answer wrong and the run stops before that write
(exit 1).

Without a terminal nothing is asked: `provider_id` and the sale ids must be
given (exit 2 otherwise), the run is a dry run, `--dry-run false` exits 2, and it
stops after the export, before the upload, since that write is confirmed by hand.

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
| `--dry-run true\|false` | `true` (the default, and what a bare `--dry-run` means): export + upload, print the task command, skip running it. `false`: run the task too. |
| `--skip-upload` | Only build the CSV (implies `--dry-run true`, `--keep-csv`; refuses `--dry-run false`). |
| `-h`, `--help` | Full help. |

## Prereqs

- Elixir on PATH (script is `backfill_missing_documents.exs`; no external deps, so no
  `Mix.install` — starts instantly).
- VPN + `houston` auth (production-developer profile for the psql read + S3
  upload).
- `aws` CLI on PATH (used inside `houston aws-shell`).
