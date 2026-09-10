# einvoicing-scripts

Ad-hoc operational scripts for Orion e-invoicing (`app-accounting-documents`).
Each script is a single executable file — run it directly, no wrappers.

Grouped by the environment it acts on, then by whether it only reads or also writes.

## Setup

Install the `ops` CLI (`~/Desktop/repos/ops`, a gh-style launcher and reader for
this repo), then let it check the machine and scaffold `.env`:

```sh
(cd ~/Desktop/repos/ops && npm ci)   # the ops repo lives next to this one
echo 'export PATH="$HOME/Desktop/repos/ops/bin:$PATH"' >> ~/.zshrc && exec zsh
ops orion doctor --fix        # creates .env from .env.example, lists blank secrets, checks node/elixir/houston
```

Then fill the secrets it flags in `.env`. (Manual equivalent: `cp .env.example .env`.)

Secrets and config live in a repo-root `.env`, auto-loaded by the scripts that
need it (anything in your shell env wins over `.env`). `.env` is gitignored —
never commit it. See `.env.example` for every variable.

## Scripts

Generated from each script's `AGENTS.md` frontmatter by `ops orion docs sync`.

<!-- ops:begin catalogue -->
### `production/read-only`

- **invopop_supplier_check** — List Invopop supplier silo entries and flag the ones stuck in error or void states _(read-only)_
- **onboard_location_scripts** ⚠️ _deprecated_ — Deprecated (pre Billing Profiles) onboarding check across shedul + accounting-documents; prints tasks to run _(read-only)_

### `production/write`

- **b2b_credit_notes** — Map each B2B credit note to the invoice it credits, or decode a document's payload_base64 on a pod _(read-only)_
- **edit_document_payload** 📄 _runbook, no script_ — Runbook: hand-edit an accounting document's payload_base64 on a pod and re-drive the send _(prod-write)_
- **fix_credit_note_references** ⛔ _blocked_ — Phase 2 of b2b_credit_notes: put the BillingReference onto the 34 rejected B2B credit notes _(prod-write)_
- **fix_invoice_payloads** — Decode an invoice's payload_base64 on a pod, patch it with an Elixir expression, emit the remediation runbook _(read-only)_
- **it_credential_lifecycle_bugbash** — Walk one IT Smart Receipts plugin through the credential email ladder in ten cases and judge each from the DB _(prod-write-irreversible)_
- **plugin_legal_entity_updates** — Link e-invoicing plugins to their primary legal entity: report, migrate, pre-flight, link, post-flight _(prod-write-no-dry-run)_
- **process_missing_sales** — Backfill invoices and credit notes for sales that never produced one: export CSV, upload to S3, run the task _(prod-write)_
- **retry_invoices** — Re-drive stuck KSA e-invoices: flip trackers retry-eligible, then force-retry sending via Houston _(prod-write)_

### `staging/write`

- **clear_provider_einvoicing** — Wipe all of a provider's e-invoicing rows from a staging accounting_documents DB in one transaction _(staging-destructive)_
- **confirm_sent_uat** — Process the Comarch UAT queue by confirming "sent" items via the edoc-online UAT REST API _(sandbox)_
- **deregister_suppliers** — Fire the Invopop supplier-deregistration workflow, one Transform job per supplier, in a sandbox workspace _(sandbox)_
<!-- ops:end catalogue -->

## Running

```sh
ops orion script list                       # the catalogue: env, access, tier, status, summary
ops orion script view <name>                # doc page + the script's live --help + examples
ops orion script run <name> [args...]       # runs the file exactly as if you typed its path
ops orion script run ri --dry-run 123,456   # aliases come from the frontmatter
ops help tiers                              # what the danger tiers mean
```

Every script also runs directly (all are executable) and prompts for anything
you don't pass; writes are gated behind confirmations and require a terminal.
Add `-h`/`--help` to any `.exs`/`.js` for its full options. Fuller detail
lives in each script's own `AGENTS.md`.

## Requirements

- **VPN** + authenticated `houston` (prod reads use `fresha-production-developer`).
- **Elixir** (`.exs` scripts) and **Node ≥ 20** (`.js` scripts) on PATH. Elixir scripts
  that need deps auto-install via `Mix.install`; the rest are dependency-free.
