---
name: force_retry_invoices
summary: "Force-retry stuck e-invoices: flip their trackers retry-eligible, then re-drive sending via Houston"
domain: e-invoicing
env: production
access: write
tier: prod-write
lang: js
examples:
  - args: ""
    note: asks for the environment, whether to dry run, the tracker ids and the review_status
  - args: "--env staging 123,456"
    note: eng-orion; asks only whether to dry run and the review_status
  - args: "--env production --dry-run true 123,456"
    note: pulls the trackers and prints the Houston commands; writes nothing
  - args: "--env production --dry-run false 123,456"
    note: each Houston task confirmed twice before it runs
---
# force_retry_invoices

Given a list of `e_invoice_tracker` IDs, it flips their status so they become
retry-eligible, then force-retries sending the underlying accounting documents.

## Pipeline

1. **Read** — `houston psql accounting_documents` (read-only) pulls the given
   trackers to learn their `accounting_document_id` + current statuses.
2. **Make eligible** — `update_einvoice_trackers_status` Houston task sets
   `upload_status -> failed_to_send` (always) and `review_status -> <picked>`.
   You pick a single `review_status` from the enum (a picker on a terminal, or
   `--review-status`) and it is applied **uniformly to every pulled tracker**, regardless of
   each one's current state — pick `rejected` to make them retry-eligible.
   (Note: it does not per-tracker preserve or branch on the existing status.)
3. **Retry** — `retry_sending_failed_accounting_documents` Houston task force-
   retries sending.

Step 2 runs first because the retry action only enqueues docs whose tracker is
`upload_status = failed_to_send` OR `review_status = rejected`.

## Safety

- It starts by asking what its flags left out (each also a flag): the environment
  (`--env production|staging`; staging runs against `eng-orion` unless
  `--namespace` names another), then `--dry-run true|false`, true by default.
  The tracker ids are a typed line.
- A dry run pulls the trackers and prints the Houston commands it would run. With
  `--dry-run false` each Houston task is confirmed with a typed `yes` — and in
  production a second time, by typing `production`. A wrong answer stops the run
  before that task; Houston then shows its own `Continue?` prompt as well.
- Without a terminal nothing is asked: the tracker ids and `--env` must be given
  and the run is a dry run; `--dry-run false` exits 2.

## Prereqs

- Node on PATH (dependency-free). VPN + `houston` auth (production-developer).
