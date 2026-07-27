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
- **plugin_legal_entity_updates** — three modes, picked at the first prompt: **pre-flight** (read-only; cross-checks `provider_billing_informations` against the legal entity field by field, PASS/FAIL), **post-flight** (read-only; is each plugin linked to its provider's primary legal entity, PASS/FAIL), and **link** (runs `link_plugins_to_legal_entities_from_env`, then reads the rows back to prove what landed). Fully interactive. Dry run by default; requires a terminal; production takes three confirmations.

### `staging/` — non-prod

**write**
- **deregister_suppliers** — fires the Invopop supplier-deregistration workflow for a sandbox workspace. Refuses non-sandbox tokens.
- **confirm_sent_uat** — processes the Comarch UAT queue (confirms "sent" items) via the edoc-online UAT API.
- **clear_provider_einvoicing** — ⚠️ _destructive._ Wipes all of a provider's e-invoicing data (account config, plugins, accounting documents, trackers, logs) from the staging `accounting_documents` DB, in FK order, in one transaction. Refuses production.

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

**plugin_legal_entity_updates** — link plugins to their primary legal entity.
```sh
./production/write/plugin_legal_entity_updates/plugin_legal_entity_updates.js
# Fully interactive — just run it, no flags to remember. It asks, in order:
#   1. WHICH MODE?      — pre-flight (default) / post-flight / link
#   2. environment      — staging (eng-orion), production, or any namespace
#   3. APPROVE READS    — target shown and confirmed BEFORE any query runs
#   4. providers        — all of them (from account_configurations), or a list you type
#   -- pre-flight and post-flight stop here with a PASS/FAIL verdict; link continues --
#   5. dry run or apply — asked after the resolution report is on screen
#   6. approve the run  — non-prod one "yes"; PRODUCTION: type the namespace back, then "yes"
#
# THREE MODES:
#   pre-flight   READ-ONLY. Cross-checks provider_billing_informations (shedul)
#                against the legal entity's jsonb fields (legal_entities) — legal
#                name, person name, tax/VAT, registration no., activity code,
#                address, country. PASS/FAIL, exit 1 on any difference. Doesn't
#                read plugins at all. Run this BEFORE linking.
#   post-flight  READ-ONLY. Is each plugin pointing at its provider's primary
#                legal entity? PASS/FAIL, exit 1 on drift. (--verify is an alias.)
#   link         Prints the exact `houston task run … link_plugins_to_legal_entities_from_env`
#                command, runs it, then VERIFIES by reading the rows back — a table
#                of plugin_id / provider_id / legal entity applied / how it was
#                verified, plus psql commands to cross-check yourself. Exits 1 if a
#                row didn't land: the task exits 0 even when it skips everything, so
#                its exit code alone proves nothing. Dry run is the default.
#
# Providers it can't resolve are listed in an "Exempt providers" table with reasons.
# Every SQL statement is echoed (cyan) before it runs; NO_COLOR is honoured.
# REQUIRES A TERMINAL: if stdin isn't a TTY it refuses outright (exit 1) — a piped
# "yes" is not explicit approval, so cron/CI can't drive it. There is no --force.
#
# Flags just pre-answer a prompt — all optional:
#   -n, --namespace NAME   namespace / env; drives the psql env AND the task's --namespace
#       --all              every provider in account_configurations
#       --preflight        read-only: billing info vs legal entity, PASS/FAIL
#       --postflight       read-only: link state, PASS/FAIL (--verify is an alias)
#   -f, --file PATH        read provider IDs from a file (# starts a comment)
#       --apply            DRY_RUN="false" — actually write
#       --dry-run          DRY_RUN="true" — logs only (the default)
#   -s, --service NAME     Houston service (default: accounting-documents)
#       --print-only       print the command and stop; run nothing
#       --json             print only the UPDATES JSON array (prompt goes to stderr)
#
# Reads three DBs: provider_purchases_primary_legal_entities + provider_billing_informations
# (shedul, valid_to IS NULL — the primary-LE query is the same SQL as the
# get_primary_legal_entity_id_for_provider RPC), account_configuration_plugins
# (accounting_documents), and legal_entities. Only proposes plugins with
# legal_entity_id IS NULL, and skips — with a reason — any provider with no primary
# LE, no plugins, or more than one unlinked plugin: a legal entity can back at most
# one plugin (unique index).
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

**clear_provider_einvoicing** — ⚠️ _destructive._ wipe a provider's e-invoicing data (staging only).
```sh
./staging/write/clear_provider_einvoicing/clear_provider_einvoicing.js <provider_id>
#   -n, --namespace NAME   staging namespace (default: eng-orion); production refused
#   --dry-run              preview row counts + print the SQL, write nothing
# Shows a per-table row-count preview, requires you to type the provider_id back
# then "yes", and runs all deletes as one transaction (rolls back on any error).
# Scope: e-invoicing domain only — does NOT touch the invoicing/ (periodic
# billing) domain or rows keyed only by invoice_entity_id.
```

## Requirements

- **VPN** + authenticated `houston` (prod reads use `fresha-production-developer`).
- **Elixir** (`.exs` scripts) and **Node** (`.js` scripts) on PATH. Elixir scripts
  that need deps auto-install via `Mix.install`; the rest are dependency-free.
