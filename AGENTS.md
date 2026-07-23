# scripts — operational toolbox

Ad-hoc operational scripts for Orion (accounting-documents / e-invoicing and
friends). Each lives in its own directory with a wrapper you can run directly;
most also have a short shell alias in `~/.zshrc`.

**How to recall a script:** skim the table, run the alias (or `./<wrapper> -h`
for full help). Every script's own directory has an `AGENTS.md`/`README.md` or a
top-of-file comment with the details.

## Quick index

| Script | Alias | Run | Env | What it does |
|--------|-------|-----|-----|--------------|
| [process_missing_sales](process_missing_sales/) | `pms` | `pms <provider_id> <sale_ids>` | **prod** | Export sales to CSV → upload to S3 → run `process_missing_sales_events` task to backfill invoices/credit notes. Step-gated. Skips sales that already have a document. |
| [retry_invoices](retry_invoices/) | `ri`, `force_retry_invoices` | `ri <tracker_ids>` | **prod** | Re-drive stuck KSA e-invoices: flip tracker statuses to retry-eligible, then force-retry sending via Houston tasks. |
| [deregister_suppliers](deregister_suppliers/) | `ds` | `ds [--dry-run]` | sandbox | Fire Invopop supplier-deregistration workflow — one Transform job per supplier in a workspace. Refuses non-sandbox tokens. |
| [invopop_supplier_check](invopop_supplier_check/) | `isc` | `isc` | prod (read) | List Invopop "suppliers" silo entries, diagnose ones in problem states. Optional provider cross-ref via psql. Read-only. |
| [onboard_location_scripts](onboard_location_scripts/) | `ols` | `ols <provider_id>` | prod (read) | Provider onboarding check across `shedul` + `accounting-documents` DBs; suggests the Houston onboarding tasks to run. Read-only + polling. |
| [confirm_sent_uat](confirm_sent_uat/) | `csu` | `csu` | UAT | Process Comarch UAT queue — confirm-sent for invoice / onboarding queues via the edoc-online UAT REST API. |
| [deploy](deploy/) | `dep`* | `dep <branch> [namespace]` | staging/**prod** | Thin wrapper over `houston x deploy` for accounting-documents. Defaults app name; `-n` = skiff render dry-run. |
| [review](review/) | `review`* | `review [app] [pr]` | n/a | Caveman-style PR review from the terminal — pick app, resolve/browse a PR, run Claude Code with the caveman-review skill. |
| [traffic_check](traffic_check/) | `tc`* | `tc` | n/a | Personal: Google Maps commute travel-time vs baseline → posts a one-line summary to Slack. |
| [reset_staging](reset_staging/) | `reset`* | `reset <COUNTRY> [--dry-run]` | **staging only** | Reset staging (eng-orion) for one country: deregister all Invopop suppliers, then wipe the accounting-documents DB. Destructive, country-gated. |
| [wipe_workspace](wipe_workspace/) | — | `houston psql … -f wipe.sql` | **staging only** | SQL to delete accounting-documents/e-invoicing data for one `provider_id`. Used by `reset_staging`; `preview.sql` first. |

\* wrapper exists but no `~/.zshrc` alias yet — run via `./<wrapper>` from the
dir, or add an alias (see below).

## Danger tiers

- **Read-only:** `isc`, `ols` (plus any `--dry-run` / `preview` path).
- **Prod writes (gated, reversible-ish):** `pms`, `ri`, `dep production`.
- **Destructive / staging-only:** `reset`, `wipe_workspace`. Country/provider
  gated; never a production path.
- **Sandbox / external:** `ds` (Invopop sandbox), `csu` (Comarch UAT), `tc`
  (personal Slack).

## Prereqs (most scripts)

- **VPN up** + `houston` authenticated. Prod DB reads use the
  `fresha-production-developer` profile; some writes need a stronger role
  (e.g. `pms` uploads to S3 with `fresha-production-team-orion`).
- Language runtimes are pinned via `.tool-versions` (asdf). Elixir scripts
  auto-install deps via `Mix.install`; Node scripts are dependency-free.

## Aliases (`~/.zshrc`)

Existing:

```sh
alias pms='cd .../scripts/process_missing_sales && ./pms'
alias ols='cd .../scripts/onboard_location_scripts && elixir onboard_location_scripts.exs'
alias csu='cd .../scripts/confirm_sent_uat && node confirm_sent_uat.js'
alias isc='cd .../scripts/invopop_supplier_check && elixir invopop_supplier_check.exs'
alias force_retry_invoices='cd .../scripts/retry_invoices && node retry_invoices.js'
```

To add a wrapper that has none (e.g. `dep`, `ds`, `reset`, `tc`, `review`):

```sh
alias dep='.../scripts/deploy/dep'
```

## Adding a new script

Follow the pattern: one directory, a main script + a symlink-safe `bash`
wrapper (see `process_missing_sales/pms`), a directory `AGENTS.md`, then a row
in the table above and an alias in `~/.zshrc`.
