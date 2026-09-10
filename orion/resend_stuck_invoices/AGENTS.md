---
name: resend_stuck_invoices
summary: "Re-drive stuck KSA e-invoices: flip trackers retry-eligible, then force-retry sending via Houston"
env: production
access: write
tier: prod-write
lang: js
examples:
  - args: 123,456
    note: tracker ids, comma-separated
  - args: "--namespace eng-orion 123,456"
    note: target another namespace
  - args: "--dry-run 123,456"
    note: plan only, no writes
---
# resend_stuck_invoices

Given a list of `e_invoice_tracker` IDs, it flips their status so they become
retry-eligible, then force-retries sending the underlying accounting documents.

## Pipeline

1. **Read** — `houston psql accounting_documents` (read-only) pulls the given
   trackers to learn their `accounting_document_id` + current statuses.
2. **Make eligible** — `update_einvoice_trackers_status` Houston task sets
   `upload_status -> failed_to_send` (always) and `review_status -> <prompted>`.
   You are always prompted for a single `review_status` (any value from the
   enum) and it is applied **uniformly to every pulled tracker**, regardless of
   each one's current state — pick `rejected` to make them retry-eligible.
   (Note: it does not per-tracker preserve or branch on the existing status.)
3. **Retry** — `retry_sending_failed_accounting_documents` Houston task force-
   retries sending.

Step 2 runs first because the retry action only enqueues docs whose tracker is
`upload_status = failed_to_send` OR `review_status = rejected`.

## Prereqs

- Node on PATH (dependency-free). VPN + `houston` auth (production-developer).
