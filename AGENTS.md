# scripts — operational toolbox

Ad-hoc operational scripts for Orion (accounting-documents / e-invoicing and
friends). Scripts are grouped by the environment they act on:

- **[production/](production/)** — touch real production data (writes or reads).
- **[staging/](staging/)** — non-prod: Invopop sandbox + Comarch UAT.

Each script is a single executable file (`.exs` or `.js`) in its own directory
alongside an `AGENTS.md` explaining it. Run the file directly — there are no
wrappers.

**How to recall a script:** skim the tables, then run `./<script> --help` or read
the script's own `AGENTS.md`.

## production/

| Script | Run | Access | What it does |
|--------|-----|--------|--------------|
| [process_missing_sales](production/process_missing_sales/) | `./process_missing_sales.exs <provider_id> <sale_ids>` | **write** | Export sales to CSV → upload to S3 → run `process_missing_sales_events` task to backfill invoices/credit notes. Step-gated. Skips sales that already have a document. |
| [retry_invoices](production/retry_invoices/) | `./retry_invoices.js <tracker_ids>` | **write** | Re-drive stuck KSA e-invoices: flip tracker statuses to retry-eligible, then force-retry sending via Houston tasks. |
| [invopop_supplier_check](production/invopop_supplier_check/) | `./invopop_supplier_check.exs` | read-only | List Invopop "suppliers" silo entries, diagnose ones in problem states. Optional provider cross-ref via psql. |
| [onboard_location_scripts](production/onboard_location_scripts/) | `./onboard_location_scripts.exs <provider_id>` | read + poll | Provider onboarding check across `shedul` + `accounting-documents` DBs; suggests the Houston onboarding tasks to run. |

## staging/

| Script | Run | Env | What it does |
|--------|-----|-----|--------------|
| [deregister_suppliers](staging/deregister_suppliers/) | `./deregister_suppliers.exs [--dry-run]` | Invopop sandbox | Fire Invopop supplier-deregistration workflow — one Transform job per supplier in a workspace. Refuses non-sandbox tokens. |
| [confirm_sent_uat](staging/confirm_sent_uat/) | `./confirm_sent_uat.js` | Comarch UAT | Process Comarch UAT queue — confirm-sent for invoice / onboarding queues via the edoc-online UAT REST API. |

## Danger tiers

- **Read-only:** `invopop_supplier_check`, `onboard_location_scripts` (plus any `--dry-run` path).
- **Prod writes (gated, reversible-ish):** `process_missing_sales`, `retry_invoices`.
- **Sandbox / external:** `deregister_suppliers` (Invopop sandbox), `confirm_sent_uat` (Comarch UAT).

## Prereqs (most scripts)

- **VPN up** + `houston` authenticated. Prod DB reads use the
  `fresha-production-developer` profile; some writes need a stronger role
  (e.g. `process_missing_sales` uploads to S3 with `fresha-production-team-orion`).
- Language runtimes are pinned via `.tool-versions` (asdf). Elixir scripts that
  need deps auto-install them via `Mix.install` (e.g. `Req`);
  `process_missing_sales` and the Node scripts are dependency-free.

## Aliases (`~/.zshrc`, optional)

Scripts run directly, but short aliases are convenient:

```sh
alias pms='.../scripts/production/process_missing_sales/process_missing_sales.exs'
alias ri='.../scripts/production/retry_invoices/retry_invoices.js'
alias isc='.../scripts/production/invopop_supplier_check/invopop_supplier_check.exs'
alias ols='.../scripts/production/onboard_location_scripts/onboard_location_scripts.exs'
alias ds='.../scripts/staging/deregister_suppliers/deregister_suppliers.exs'
alias csu='.../scripts/staging/confirm_sent_uat/confirm_sent_uat.js'
```

## Adding a new script

Follow the pattern: pick `production/` or `staging/`, one directory per script,
a single executable entrypoint (`.exs` with `#!/usr/bin/env elixir`, or `.js`
with `#!/usr/bin/env node`), and a directory `AGENTS.md`. Then add a row to the
right table above.
