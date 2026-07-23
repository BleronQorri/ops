# invopop_supplier_check

**Env: production (read-only).** Lists Invopop "suppliers" silo entries and
diagnoses ones stuck in problem states.

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

## Run it

```bash
./invopop_supplier_check.exs                 # list + classify all supplier entries
./invopop_supplier_check.exs --problems      # only entries in problem states
./invopop_supplier_check.exs --report        # generate a report file
./invopop_supplier_check.exs --debug         # verbose
```

Optional provider cross-reference uses `houston psql accounting-documents`
(read-only).

## Prereqs

- Elixir on PATH (`Mix.install` pulls `req` + `nimble_csv`).
- `INVOPOP_API_TOKEN` for the target workspace. VPN + `houston` only if using
  the psql cross-reference.
