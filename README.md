# einvoicing-scripts

Ad-hoc operational scripts for Orion e-invoicing (`app-accounting-documents`).
Each script is a single executable file — run it directly, no wrappers.

Grouped by the environment it acts on, then by whether it only reads or also writes.

## Scripts

### `production/` — touches real production data

**read-only**
- **account_config_legal_entity_audit** — where has a provider's tax identity drifted away from its legal entity? Walks every `account_configuration`, follows each plugin's `legal_entity_id`, and reports a verdict per field. Separates the ISO-country-prefix cases (which the app itself treats as equal) from real conflicts, and says which side is malformed. Read-only, with no write path in the file.
- **invopop_supplier_check** — lists Invopop supplier silo entries and flags ones stuck in error/void states. Read-only.
- **onboard_location_scripts** — ⚠️ _deprecated (Billing Profiles migration)._ Provider onboarding check across `shedul` + `accounting-documents`; prints the Houston tasks to run.

**write**
- **b2b_credit_notes** — maps B2B credit notes to the invoice each one credits. `provider_invoices` has no pointer between them, so it matches on amount: one of the provider's e-invoiced invoices whose total covers the credit note, in any billing period. Its only mode today is read-only; it lives under `write/` for a planned mutating mode.
- **process_missing_sales** — backfills invoices/credit notes for sales that never produced one (export → S3 → Houston task). Step-gated.
- **retry_invoices** — re-drives stuck KSA e-invoices: flips tracker statuses retry-eligible, then force-retries sending.
- **plugin_legal_entity_updates** — eight modes, picked at the first prompt (**guided** walks the sequence with every step defined — start there): **report** (read-only; scouts every provider in `account_configurations` before you roll out — migrated vs not, ready vs blocked and why, with providers whose country has no e-invoicing rules reported as such rather than scored; full per-provider tables in Markdown; a survey, so it never fails), **migrate** (creates the legal entities via `legal_entities_migration:migrate` on `partners-app`; explicit provider list only, no dry run so it previews state first), **pre-flight** (read-only; cross-checks `provider_billing_informations` against the legal entity field by field, PASS/FAIL), **post-flight** (read-only; is each plugin linked to its provider's primary legal entity, PASS/FAIL), **link** (runs `link_plugins_to_legal_entities_from_env`, then reads the rows back to prove what landed), and **reset** (⚠️ _staging only, destructive_ — undoes the migration for a provider so it can be re-run). Fully interactive. Dry run by default; requires a terminal; production takes three confirmations.

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

**account_config_legal_entity_audit** — has a provider's tax identity drifted from its legal entity?
```sh
./production/read-only/account_config_legal_entity_audit/account_config_legal_entity_audit.js --yes
#   -n, --namespace NAME   namespace / psql env (default: production)
#       --country XX       only this country; repeatable (SA / ES / IT)
#       --provider ID      only this provider_id; repeatable or comma-separated
#       --conflicts-only   hide rows that compared cleanly (terminal view only; the
#                          Markdown and CSV always carry every row)
#       --include-prefix   count PREFIX as a conflict (default: its own bucket)
#       --md [PATH] / --no-md      the Markdown report (written by default)
#       --csv / --no-csv   write the CSV or don't, either way no prompt
#       --json             one result document on stdout, human lines on stderr
#   -y, --yes              approve the READS without a terminal
#
# READ-ONLY, STRUCTURALLY: there is no `houston psql --write` and no `houston task run`
# anywhere in the file. `grep -nE '\-\-write|task run'` is the test. So --yes is safe to
# automate — there is no stronger action it could unlock.
#
# app-accounting-documents stores a provider's tax identity twice: on its own columns
# (account_configurations.tax_id / .vat_number / .company_registration_number /
# .country_code, mirrored onto the plugin as parent_number / branch_number /
# country_code) and on the legal entity that account_configuration_plugins.legal_entity_id
# points at. THE TWO ARE SNAPSHOTS, NOT A LINK — maybe_update_tax_id/2 refreshes the
# columns only on a re-onboarding or a manual task run, and nothing subscribes to
# legal-entity change events. The columns still back the onboarding uniqueness pre-check
# and the KSA Fresha-B2B CRN fallback, so a stale one has consequences.
#
# THE COMPARISON IS PLUGIN-LEVEL ON PURPOSE. Provider 1135636 holds two enabled plugins
# against one configuration; the branch one (is_default = false) carries a DIFFERENT CRN
# by design (hardcoded in comarch/billing_details_policy.ex @ksa_location_branch_numbers).
# Comparing account_configurations.company_registration_number invents a conflict for it;
# comparing plugins.branch_number does not.
#
#   plugins.parent_number  vs  <shape>.vatNumber          (IDENTIFIER_KIND_TAX_NUMBER —
#                                                          NOT taxInformation.number,
#                                                          which is a different kind)
#   plugins.branch_number  vs  <shape>.registrationNumber
#   plugins.country_code   vs  the entity's country_code column
#
# <shape> is resolved per business_type, so an ES sole trader reads
# soleProprietorship.vatNumber off the CHILD entity (joined via
# legal_entity_associations) and an SA organization reads organization.vatNumber off the
# root. Reading the root alone reports every populated ES/IT provider as missing
# everything.
#
# NOT COMPARED: `configuration` jsonb ({} on all 442 rows, read nowhere in src/),
# `enabled` (dead — not even in the Ecto schema), `vat_number` (a write-only duplicate of
# tax_id — asserted equal instead of compared twice), `currency_code` (no counterpart).
#
# Verdicts: MATCH / PREFIX / CONFLICT / LE ONLY / CONFIG ONLY / NEITHER / NO SLOT.
# PREFIX means the two sides are equal under the application's OWN tax_id_variants/2
# normalisation and differ only by the leading ISO country code (ESB63912596 vs
# B63912596) — not a discrepancy, and its own bucket so it never buries the real ones.
# CONFLICT is sub-labelled CONFIG MALFORMED / LE MALFORMED / BOTH MALFORMED / BOTH VALID
# using ValidationHelpers' KSA rules, because which side is malformed IS the finding: a
# corrupt column against a well-formed entity has an obvious fix, two well-formed values
# naming different numbers needs a human.
#
# States: COMPARED, UNLINKED (provider-side plugin with no legal_entity_id — every send
# is refused with {:error, :missing_legal_entity_id}), LE MISSING, NO PLUGIN, and
# FRESHA ENTITY (an invoice_entity_id configuration, which has NO legal entity by design
# and is excluded from every tally — production's one `enabled` plugin without a legal
# entity is exactly this, and counting it would report an outage that doesn't exist).
#
# Also checks accounting-documents against ITSELF, restating the invariants the service's
# own pre_flight_check/0 helpers assert: tax_id == vat_number == plugin.parent_number,
# country_code == plugin.country_code, crn == plugin.branch_number (default plugins ONLY
# — branch plugins are listed as exempt), provider_id == plugin.provider_id where
# populated, and unique_tax_entity_per_plugin.
#
# Prints a matrix, per-country tallies, a detail section for every row that didn't
# compare cleanly, then a summary. Writes
# account-config-le-audit-<namespace>-<YYYY-MM-DD>.md and offers the same table as .csv.
# Exit: 0 clean, 1 a CONFLICT / LE MISSING / failed internal check, 2 the call was wrong.
#
# Production baseline (2026-09-07), useful as a regression test — 443 rows: 312 COMPARED,
# 130 UNLINKED (0 of them enabled), 1 FRESHA ENTITY, 0 LE MISSING. Tax number: 294 MATCH,
# 5 PREFIX, 12 CONFLICT (9 CONFIG MALFORMED, 3 BOTH VALID — all SA), 1 CONFIG ONLY.
# Registration number: 0 conflicts. Internal checks all pass. Exit 1.
#
# WATCH OUT: the legal-entity field query must keep `WHERE le.id IN (...)` inside BOTH
# arms of its UNION. Hoisted to an outer filter, jsonb_array_elements unnests 246k+
# sole-proprietorship rows and the statement times out.
```

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

**b2b_credit_notes** — which invoice does each B2B credit note belong to?
```sh
./production/write/b2b_credit_notes/b2b_credit_notes.js
#   -n, --namespace <ns>   default production
#       --ids <list>       accounting_documents.id values, comma or space separated
#       --mode <mode>      matrix (the only one today)
#       --csv / --no-csv   write the CSV or don't, either way no prompt
#   -y, --yes              approve the READS without prompting (read-only modes only)
#
# Interactive with no flags: asks for the mode, the namespace, then the credit note
# accounting_documents.id values (comma or newline separated, blank line to finish).
# Non-interactive: --ids plus --yes needs no terminal.
#   ./b2b_credit_notes.js --ids 4838124,4838004 --yes --csv
#
# Its only mode today, "matrix", is READ-ONLY — SELECTs in both databases, no
# houston psql --write anywhere. It lives here because a mutating mode is planned;
# READ_ONLY_MODES in the script gates any mode not on that list behind a TTY.
#
# A credit note has no pointer to its invoice — shedul's provider_invoices has no
# original_invoice_id. The match is one of the provider's E-INVOICED invoices whose
# total is >= the credit note's value, in ANY billing period. Among those, the credit
# note's own period wins, then the most recent invoice created at or before it.
# Statuses are reported, never matched on. Both billing periods are shown side by
# side with a Period column flagging same vs DIFFERENT.
#
# The credit note's value is summed from provider_invoice_items — NOT
# provider_invoices.total, which on 280 of 295 production credit notes carries the
# invoice's total instead of its own. 37 of 295 credit notes legitimately exceed every
# invoice in their own period, which is why the period is not a hard constraint.
# Restricting candidates to einvoice_reference IS NOT NULL costs 2 of 295 matches and
# keeps the answer to documents ZATCA has actually seen.
#
# Reads accounting_documents (validate the input + ZATCA status) and shedul
# (provider, periods, amounts, the invoices themselves).
#
# Prints a matrix and writes b2b-credit-notes-<namespace>-<YYYY-MM-DD>.md, then
# offers the same table as .csv. Piping answers in works; a trailing 'y' takes the
# CSV, and running out of input at that prompt skips it rather than failing.
# Exit 1 if anything is UNMATCHED / ORPHAN or wasn't a B2B credit note.
```

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
#   1. WHICH MODE?      — guided (default, start here) / migrate / pre-flight / link /
#                         post-flight / plugin-audit / reset. Each option shows its
#                         stage and a one-line description.
#                         GUIDED walks the whole sequence with every step defined —
#                         start there if you don't remember the order.
#   2. environment      — staging (eng-orion), production, or any namespace
#   3. APPROVE READS    — target shown and confirmed BEFORE any query runs
#   4. providers        — all of them (from account_configurations), or a list you type
#                         (migrate: an explicit list only, never "all")
#   -- pre-flight and post-flight stop here with a PASS/FAIL verdict; link continues --
#   5. dry run or apply — asked after the resolution report is on screen
#   6. approve the run  — non-prod one "yes"; PRODUCTION: type the namespace back, then "yes"
#
# SEVEN MODES — workflow order is migrate → pre-flight → link → post-flight.
#   plugin audit READ-ONLY. Billing info vs the legal entity each PLUGIN points at
#                (BillingDetailsPolicy reads plugin.legal_entity_id, not the primary),
#                one section per plugin. Providers discovered from the plugins table.
#   guided       Walks pre-flight → link → post-flight, printing what each step is,
#                why it exists and what to watch for, then running them one at a time
#                as separate invocations. Does NOT run migrate (a precondition: no dry
#                run, and an RPC side effect) or reset — both are described, not run.
#   reset        STAGING ONLY, destructive. Undoes the migration for a provider.
#   migrate      Runs `legal_entities_migration:migrate` on the partners-app service
#                to CREATE each provider's legal entity and set it primary. Explicit
#                provider list only (never "all"). This task has NO dry run, so a
#                read-only preview of each provider's current migration state is
#                shown first; it is resumable, so a re-run resumes rather than
#                duplicating. MIGRATE_PAYMENT_METHODS defaults to true and also
#                migrates cards on file via an RPC — --no-payment-methods skips it.
#   pre-flight   READ-ONLY. Cross-checks provider_billing_informations (shedul)
#                against the legal entity's jsonb fields (legal_entities), AND checks
#                the per-country REQUIRED set from app-accounting-documents (SA via
#                Comarch, ES/IT via Common) — a required field missing on the legal
#                entity side is flagged as blocking e-invoicing. Fields: legal
#                name, person name, tax/VAT, registration no., activity code,
#                address, country. PASS/FAIL, exit 1 on any difference. Doesn't
#                read plugins at all. Run this BEFORE linking.
#   post-flight  READ-ONLY. Is each plugin pointing at its provider's primary
#                legal entity? PASS/FAIL, exit 1 on drift.
#   link         Prints the exact `houston task run … link_plugins_to_legal_entities_from_env`
#                command, runs it, then VERIFIES by reading the rows back — a table
#                of plugin_id / provider_id / legal entity applied / how it was
#                verified, plus psql commands to cross-check yourself. Exits 1 if a
#                row didn't land: the task exits 0 even when it skips everything, so
#                its exit code alone proves nothing. Dry run is the default.
#
# Providers it can't resolve are listed in an "Exempt providers" table with reasons.
# Every SQL statement is echoed (cyan) before it runs; NO_COLOR is honoured.
#
# WRITES REQUIRE A TERMINAL. --link --apply, --migrate and --reset refuse outright
# if stdin isn't a TTY, in every namespace — a piped "yes" is not explicit approval,
# and no flag can supply one. There is no --force.
#
# READ-ONLY MODES CAN BE AUTOMATED. --yes lifts the TTY requirement for the modes
# that only issue SELECTs (--preflight, --postflight, --plugins) and for
# --link --dry-run, and --json emits one result document on stdout with every
# human-readable line on stderr. Exit: 0 pass, 1 the data is wrong, 2 the call is
# wrong. So an agent or a CI job can report, but never write:
#
#   ./plugin_legal_entity_updates.js --postflight --all --json --yes | jq .verdict
#
# Run it with no flags and every choice is a prompt instead: mode, environment,
# read approval, providers, dry-run-vs-apply, payment methods, soft-delete,
# Markdown export. Flags only pre-answer those questions.
#
# Flags — all optional:
#   -n, --namespace NAME   namespace / env; drives the psql env AND the task's --namespace
#   -s, --service NAME     Houston service (default: accounting-documents)
#   -f, --file PATH        read provider IDs from a file (# starts a comment)
#       --all              every provider in account_configurations (not for migrate/reset)
#       --guided --migrate --preflight --postflight --link --plugins --reset
#                          pick the mode up front (--verify is an alias for --postflight)
#       --apply / --dry-run    DRY_RUN="false" / "true" (dry run is the default)
#       --print-only       print the command and stop; run nothing
#       --no-payment-methods / --copy-tax-number / --batch-size N   migrate params
#       --keep-legal-entities  reset: don't soft-delete the orphaned legal entities
#       --md [PATH]        export the report as Markdown (default preflight-<ns>-<date>.md)
#       --detail / --summary   force the per-provider field checklist on/off
#       --json             machine-readable result on stdout, report on stderr
#       --yes              run without a terminal — READ-ONLY MODES ONLY

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
# Fully interactive: prompts for queue type (invoice/onboarding/aperak) and, unless
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
