# scripts — operational toolbox

Ad-hoc operational scripts for Orion (accounting-documents / e-invoicing and
friends). Scripts are grouped first by the environment they act on, then by
whether they only read or also write:

- **[production/](production/)** — touch real production data.
  - **[read-only/](production/read-only/)** — never mutate.
  - **[write/](production/write/)** — mutate prod (gated).
- **[staging/](staging/)** — non-prod: Invopop sandbox + Comarch UAT (all write).

Each script is a single executable file (`.exs` or `.js`) in its own directory
alongside an `AGENTS.md` explaining it. Run the file directly — there are no
wrappers.

**How to recall a script:** skim the tables, then run `./<script> --help` or read
the script's own `AGENTS.md`.

## production/read-only/

| Script | Run | What it does |
|--------|-----|--------------|
| [invopop_supplier_check](production/read-only/invopop_supplier_check/) | `./invopop_supplier_check.exs` | List Invopop "suppliers" silo entries, diagnose ones in problem states. Optional provider cross-ref via psql. |
| [onboard_location_scripts](production/read-only/onboard_location_scripts/) ⚠️ **DEPRECATED** | `./onboard_location_scripts.exs <provider_id>` | **Deprecated — Billing Profiles migration** (checks the pre-migration onboarding model; legacy/reference only). Provider onboarding check across `shedul` + `accounting-documents` DBs; reads + polls, and prints the Houston onboarding tasks to run (never runs them). |

## production/write/

| Script | Run | What it does |
|--------|-----|--------------|
| [process_missing_sales](production/write/process_missing_sales/) | `./process_missing_sales.exs <provider_id> <sale_ids>` | Export sales to CSV → upload to S3 → run `process_missing_sales_events` task to backfill invoices/credit notes. Step-gated. Skips sales that already have a document. |
| [retry_invoices](production/write/retry_invoices/) | `./retry_invoices.js <tracker_ids>` | Re-drive stuck KSA e-invoices: flip tracker statuses to retry-eligible, then force-retry sending via Houston tasks. |
| [plugin_legal_entity_updates](production/write/plugin_legal_entity_updates/) | `./plugin_legal_entity_updates.js` (fully interactive) | Providers ↔ **primary** legal entities; workflow order migrate → pre-flight → link → post-flight. First prompt picks one of four modes: **migrate** (runs `legal_entities_migration:migrate` on `partners-app` to create the legal entities — explicit provider list only, no dry run so it previews each provider's migration state first, then reads back), **pre-flight** (default; read-only, cross-checks `provider_billing_informations` against the legal entity's jsonb fields, PASS/FAIL), **post-flight** (read-only; link state, PASS/FAIL) or **link** (runs `link_plugins_to_legal_entities_from_env`). Then prompts for env, providers (all, or a list), and dry-run-vs-apply. Reads `provider_purchases_primary_legal_entities` (shedul, `valid_to IS NULL` — same SQL as the `get_primary_legal_entity_id_for_provider` RPC) + `account_configuration_plugins`. Verifies by reading the rows back afterwards (per-plugin table + cross-check commands; exits 1 if a row didn't land) and prints an exempt-providers roster. Dry run by default. **Requires a TTY** — refuses piped/CI input outright, and gates the DB reads too, so nothing touches real data unapproved; prod apply takes three confirmations. |

## staging/write/

| Script | Run | Env | What it does |
|--------|-----|-----|--------------|
| [deregister_suppliers](staging/write/deregister_suppliers/) | `./deregister_suppliers.exs [--dry-run]` | Invopop sandbox | Fire Invopop supplier-deregistration workflow — one Transform job per supplier in a workspace. Refuses non-sandbox tokens. |
| [confirm_sent_uat](staging/write/confirm_sent_uat/) | `./confirm_sent_uat.js` | Comarch UAT | Process Comarch UAT queue — confirms "sent" (`POST …/status/sent/confirm`) for invoice / onboarding queues via the edoc-online UAT REST API. |
| [clear_provider_einvoicing](staging/write/clear_provider_einvoicing/) | `./clear_provider_einvoicing.js <provider_id>` | staging DB | Wipe ALL of a provider's e-invoicing data (account_configurations + plugins + accounting_documents + trackers + logs, FK order, one transaction) via `houston psql --write`. Refuses production. |

## Danger tiers

- **Read-only:** `invopop_supplier_check`, `onboard_location_scripts`,
  `plugin_legal_entity_updates` in **pre-flight** or **post-flight** mode
  (SELECTs only — cannot write at all), plus any dry-run path.
- **Prod writes (gated, reversible-ish):** `process_missing_sales`, `retry_invoices`,
  `plugin_legal_entity_updates` in **link** mode (dry run by default; requires a
  TTY; three confirmations on a prod apply).
- **Prod writes with NO dry run:** `plugin_legal_entity_updates` in **migrate**
  mode — `legal_entities_migration:migrate` writes on the first call. Resumable
  (a re-run resumes, never duplicates) and gated behind a read-only state preview
  plus the usual confirmations, but there is nothing to rehearse with.
- **Sandbox / external:** `deregister_suppliers` (Invopop sandbox), `confirm_sent_uat` (Comarch UAT).
- **Staging destructive wipe (gated):** `clear_provider_einvoicing` (deletes a provider's e-invoicing rows; refuses prod), `plugin_legal_entity_updates` in **reset** mode (undoes the legal-entities migration: drops migration state, location assignments and the primary pointer, soft-deletes the legal entities; refuses prod; per-provider confirm).

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
alias pms='.../scripts/production/write/process_missing_sales/process_missing_sales.exs'
alias ri='.../scripts/production/write/retry_invoices/retry_invoices.js'
alias isc='.../scripts/production/read-only/invopop_supplier_check/invopop_supplier_check.exs'
alias ols='.../scripts/production/read-only/onboard_location_scripts/onboard_location_scripts.exs'
alias ds='.../scripts/staging/write/deregister_suppliers/deregister_suppliers.exs'
alias csu='.../scripts/staging/write/confirm_sent_uat/confirm_sent_uat.js'
```

## Adding a new script

Follow the pattern: pick the env (`production/` or `staging/`) then the access
group (`read-only/` or `write/`), one directory per script, a single executable
entrypoint (`.exs` with `#!/usr/bin/env elixir`, or `.js` with
`#!/usr/bin/env node`), and a directory `AGENTS.md`. Then add a row to the right
table above.
