---
name: invopop_supplier_check
summary: List Invopop supplier silo entries and flag the ones stuck in error or void states
env: production
access: read-only
tier: read-only
lang: exs
aliases: [isc]
help_flag: false
examples:
  - args: ""
    note: list + classify every supplier entry
  - args: "--problems"
    note: only entries in a problem state
  - args: "--report"
    note: also write a Markdown report and a CSV
  - args: "--debug"
    note: verbose
env_vars: [INVOPOP_API_TOKEN, INVOPOP_API_BASE_URL]
reports: ["invopop_report_*.md", "invopop_entries_*.csv"]
---
# invopop_supplier_check

## What it does

- Queries the Invopop REST API (`https://api.invopop.com`) via `Req` for the
  `suppliers` silo folder. No Houston needed for the core check.
- Classifies each entry's `state`: ok (`registered`, `completed`, …), pending
  (`draft`, `processing`, …), error (`error`, `rejected`, `invalid`), voided
  (`void`, `cancelled`). Anything not clearly ok is surfaced as a problem so
  nothing stuck stays hidden.
- **Read-only** — never writes to Invopop.

The Bearer token (`INVOPOP_API_TOKEN`, else paste prompt) selects the
workspace/integration (ES, IT, …) being queried.

## Prereqs

- Elixir on PATH (`Mix.install` pulls `req` + `nimble_csv`).
- `INVOPOP_API_TOKEN` for the target workspace. VPN + `houston` only if using
  the psql cross-reference.
