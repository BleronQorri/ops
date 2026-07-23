# einvoicing-scripts

Ad-hoc operational scripts for Orion e-invoicing (`app-accounting-documents`).
Each script is a single executable file — run it directly, no wrappers.

Grouped by the environment it acts on, then by whether it only reads or also writes.

## Scripts

### `production/` — touches real production data

**read-only**
- **invopop_supplier_check** — lists Invopop supplier silo entries and flags ones stuck in error/void states. Read-only.
- **onboard_location_scripts** — ⚠️ _deprecated (Billing Profiles migration)._ Provider onboarding check across `shedul` + `accounting-documents`; prints the Houston tasks to run.

**write**
- **process_missing_sales** — backfills invoices/credit notes for sales that never produced one (export → S3 → Houston task). Step-gated.
- **retry_invoices** — re-drives stuck KSA e-invoices: flips tracker statuses retry-eligible, then force-retries sending.

### `staging/` — non-prod

**write**
- **deregister_suppliers** — fires the Invopop supplier-deregistration workflow for a sandbox workspace. Refuses non-sandbox tokens.
- **confirm_sent_uat** — processes the Comarch UAT queue (confirms "sent" items) via the edoc-online UAT API.

## Setup

Run the setup script — it scaffolds `.env`, tells you which secrets to fill, and
checks the runtimes (`node`, `elixir`, `houston`) are on PATH:

```sh
./setup-script-env.js
```

Then fill the secrets it flags in `.env`. (Manual equivalent: `cp .env.example .env`.)

Secrets and config live in a repo-root `.env`, auto-loaded by the scripts that
need it (anything in your shell env wins over `.env`). `.env` is gitignored —
never commit it. See `.env.example` for every variable.

## Running

Run each script directly (all are executable). Every one prompts for anything
you don't pass and gates writes behind a confirmation. Add `-h`/`--help` to any
`.exs`/`.js` for its full options. Fuller detail lives in each script's own
`AGENTS.md`.

### production/read-only

**invopop_supplier_check** — list + diagnose Invopop supplier silo entries.
```sh
./production/read-only/invopop_supplier_check/invopop_supplier_check.exs
#   --problems   only entries in a problem state
#   --report     also write a Markdown report file
#   --debug      verbose
# Needs INVOPOP_API_TOKEN (prod workspace). The optional DB cross-ref prompt is
# deprecated (Billing Profiles migration).
```

**onboard_location_scripts** — ⚠️ _deprecated (Billing Profiles migration)._
```sh
./production/read-only/onboard_location_scripts/onboard_location_scripts.exs <provider_id>
# Prompts a "still deprecated, continue? (y/N)" gate on startup.
```

### production/write

**process_missing_sales** — backfill invoices/credit notes for sales missing them.
```sh
./production/write/process_missing_sales/process_missing_sales.exs <provider_id> <sale_id1,sale_id2,...>
#   --dry-run        export + upload, print the task cmd, don't run it
#   --skip-upload    only build the CSV (implies --dry-run, --keep-csv)
#   --keep-csv       keep the generated CSV
#   --profile NAME   AWS profile (default fresha-production-team-orion)
# Interactive: run with no args and it prompts for provider_id + sale ids.
```

**retry_invoices** — re-drive stuck KSA e-invoices.
```sh
./production/write/retry_invoices/retry_invoices.js <tracker_id1,tracker_id2,...>
#   -n, --namespace NAME   target namespace (default: production)
#   --dry-run              plan only, no writes
#   --skip-update          skip the tracker-status update step
#   --skip-retry           skip the force-retry step
```

### staging/write

**deregister_suppliers** — fire Invopop deregistration for a sandbox workspace.
```sh
./staging/write/deregister_suppliers/deregister_suppliers.exs
#   --dry-run              plan only, POST nothing
#   --latest-only          one job per supplier (default: one per silo entry)
#   --skip-void            skip already-void entries (default: include them)
#   --wait N               block up to N seconds per job
#   --workflow-id UUID     override the workflow id
# Needs INVOPOP_SANDBOX_API_TOKEN; refuses non-sandbox workspaces.
```

**confirm_sent_uat** — process the Comarch UAT "sent" queue.
```sh
./staging/write/confirm_sent_uat/confirm_sent_uat.js
# Fully interactive: prompts for queue type (invoice/onboarding) and, unless
# COMARCH_UAT_JWT is set, the Comarch JWT.
```

## Requirements

- **VPN** + authenticated `houston` (prod reads use `fresha-production-developer`).
- **Elixir** (`.exs` scripts) and **Node** (`.js` scripts) on PATH. Elixir scripts
  that need deps auto-install via `Mix.install`; the rest are dependency-free.
