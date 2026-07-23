# retry_invoices

**Env: production (writes).** Re-drives stuck KSA e-invoices via Houston.

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

## Run it

```bash
./retry_invoices.js 123,456                        # tracker ids (comma-separated)
./retry_invoices.js --namespace eng-orion 123,456  # target another namespace
./retry_invoices.js --dry-run 123,456              # plan only, no writes
```

## Prereqs

- Node on PATH (dependency-free). VPN + `houston` auth (production-developer).
