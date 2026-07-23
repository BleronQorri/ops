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

```sh
./production/write/process_missing_sales/process_missing_sales.exs --help
./production/read-only/invopop_supplier_check/invopop_supplier_check.exs
```

Each script supports `--help`. Full per-script detail is in the `AGENTS.md`
inside each script's directory; the top-level `AGENTS.md` has the index tables.

## Requirements

- **VPN** + authenticated `houston` (prod reads use `fresha-production-developer`).
- **Elixir** (`.exs` scripts) and **Node** (`.js` scripts) on PATH. Elixir scripts
  that need deps auto-install via `Mix.install`; the rest are dependency-free.
