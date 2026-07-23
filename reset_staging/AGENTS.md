# reset_staging

Resets **staging (eng-orion)** to a pristine state for one country: deregisters all
suppliers in Invopop, then wipes the accounting-documents DB for that country.

**Staging only.** The DB env is hardcoded to `eng-orion`; there is no production path.

## What it does

Country code is the **gate** — you must pass one, and it scopes everything.

1. **Invopop (deregister-only)** — for each sandbox workspace of the country, runs
   `../deregister_suppliers/ds`, which deregisters **every silo entry, every state**
   (per-entry is the default). Silo entries are left in place, not deleted.
   - `ES` → `ES VeriFactu`, `ES TicketBAI`
   - `IT` → `IT SmartReceipts`

   `ds` prompts for that workspace's sandbox token, confirms the workspace, and lets you
   pick the deregister workflow. It refuses to run against a non-sandbox workspace.

2. **DB wipe** — previews then wipes the whole accounting-documents / e-invoicing cluster
   `WHERE account_configuration.country_code = <COUNTRY>`, via
   `../wipe_workspace/{preview,wipe}.sql` through `houston psql`.

Order is Invopop → DB, so the tax-authority side is cleaned before the local records that
reference it are dropped.

## Run

```bash
cd scripts/reset_staging

# Plan everything (Invopop --dry-run + DB preview only):
./reset ES --dry-run

# Full reset for a country:
./reset ES

# One side only:
./reset IT --db-only        # skip Invopop
./reset IT --invopop-only   # skip DB
```

Prompts: type the country code to start, per-workspace y/skip for Invopop, and `yes` before
the DB wipe (after seeing the preview counts).

## Not covered

- The `invoices` / `invoice_*` cluster (no country column; buyer parties shared) — see
  `../wipe_workspace/AGENTS.md`.
- Deleting Invopop silo entries (this is deregister-only by design).
- Global tables (`comarch_jwt_tokens`, `oban_*`, `outbox_events`, etc.).
