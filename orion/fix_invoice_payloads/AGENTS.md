---
name: fix_invoice_payloads
summary: Decode an invoice's payload_base64 locally, patch it with an Elixir expression, emit the remediation runbook
env: production
access: write
tier: read-only
lang: js
aliases: [fip]
examples:
  - args: ""
    note: fully interactive
  - args: "--ids 4687595,4762930 --yes"
    note: decode only
  - args: "--ids 4687595 --patch-file fix.exs --yes"
    note: apply a patch expression and get the runbook for each document
reports: ["invoice-payloads-*.csv", "invoice-payloads-*.sql", originals/]
related: [edit_document_payload, b2b_credit_notes]
---
# fix_invoice_payloads

Automates both halves of [edit_document_payload](../edit_document_payload/) for
`document_type = 'invoice'` documents: read `payload_base64`, decode it locally, apply a
patch, verify the bytes, and print the exact remediation sequence the document needs —
conditional on its country, its persisted line items and its tracker's current state.

`accounting_documents.payload_base64` is
`Base.encode64(:erlang.term_to_binary(%AccountingDocuments.Structs.BillingDocument{}))`,
written once at document creation. Every value starts `g3` (0x83, the Erlang External Term
Format version byte), so nothing but a BEAM can read it.

## What it does

Two modes, picked with `--mode` or the first prompt:

- **decode** — read the payloads from the target namespace, decode them in the service's own
  BEAM, write a
  CSV with the pretty-printed term per document. No fix needed yet.
- **patch** — additionally apply an Elixir patch expression (`--patch-file`, bound to `doc`
  and `id`), re-encode, run the assertions, and emit one `houston task run …`
  sequence per document for a human to run. Documents failing an assertion are dropped, not
  caveated.

The decode runs in the service's **own checkout** — `mix run --no-start -e '<decoder>'` with
`app-accounting-documents/src` as the working directory (`--app-dir`, env
`ACCOUNTING_DOCUMENTS_DIR`, default the sibling checkout). `--no-start` compiles if needed and
loads every umbrella app's modules — `BillingDocument`, `Decimal`, `Plug.Crypto`, `Jason` —
but starts nothing: no Repo, no database, no network. It is the scripted form of an IEx shell
in that directory. Payloads go in over stdin and come back as one `ROW <json>` line per
document; everything else mix prints is discarded. For another service, point `--app-dir` at
that service's checkout. It must have its deps fetched (`mix deps.get`); this script never
writes there.

This replaces an earlier path that borrowed a staging pod through `houston console … eval`,
which needed cluster exec rights and a release path that moved with every redeploy.

Why not [b2b_credit_notes/decode_payloads.js](../b2b_credit_notes/)? That one's patch is a
single literal (`previous_receipt_number`) and its assertions and CSV are credit-note-shaped.
The plumbing here is copied, not imported — one directory, one entrypoint, no shared library.

## Safety

- **Read-only.** SELECTs, a pure-function decode in a local BEAM that starts no application,
  and files
  in the working directory. No `houston psql --write`, no `houston task run`, ever — the
  runbook it prints is for you to run.
- Every statement, every mix command and the whole patch expression are echoed before
  anything runs.
- A confirmation gate before the first read; production defaults to Cancel.
- Ids are validated as integers and base64 against RFC 4648 before either reaches a command
  line.
- The original payload of every document is saved to `originals/<id>.b64` in the current
  directory. That file is the only rollback there is.

## Prereqs

- VPN up, `houston` authenticated (prod reads use `fresha-production-developer`).
- Node only, no dependencies — plus a local `app-accounting-documents` checkout with its deps
  fetched, which is where the decode runs.

## Output

- `invoice-payloads-<namespace>-<YYYY-MM-DD>.csv` — one record per document, before and after;
  the term spans lines, so read it with a real CSV parser.
- `invoice-payloads-<namespace>-<YYYY-MM-DD>.sql` — every query that ran.
- `originals/<id>.b64` — the untouched payloads.
- Exit 0 when every document was processed, 1 when any was dropped, 2 on a bad call.
