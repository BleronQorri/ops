# orion/ — operational scripts

Ad-hoc operational scripts for Orion (accounting-documents / e-invoicing and
friends). One directory per script, named after its single executable entrypoint
(`.exs` or `.js`), with an `AGENTS.md` beside it whose frontmatter declares the
environment it acts on (`production` / `staging`), whether it only reads or also
writes, and its danger tier. Run the file directly — there are no wrappers. The
`ops` CLI (`../bin/ops`) is a launcher and a reader over this directory, nothing
more: it never changes a script's arguments, prompts or gates.

**How to recall a script:** `ops orion script list`, then
`ops orion script view <name>` (its doc page, live `--help` and examples), then
`ops run <name> …`. Without `ops`: skim the tables below, then run
`./<name>/<name>.js --help` or read the script's own `AGENTS.md`.

The tables and the tier list below are **generated** from each script's
frontmatter by `ops orion docs sync` and checked by `ops orion docs check`.
Edit the frontmatter, not the tables.

## production · read-only

<!-- ops:begin catalogue:production/read-only -->
| Script | For | Tier | Run | What it does |
|--------|-----|------|-----|--------------|
| [check_invopop_suppliers](check_invopop_suppliers/) | ES · verifactu | read-only | `ops run check_invopop_suppliers` | List Invopop supplier silo entries and flag the ones stuck in error or void states |
| [lookup_invopop_receipt](lookup_invopop_receipt/) | IT · smart_receipts | read-only | `ops run lookup_invopop_receipt` | Find one IT Smart Receipt in Invopop by its number and report its state, faults and links |
<!-- ops:end catalogue:production/read-only -->

## production · write

<!-- ops:begin catalogue:production/write -->
| Script | For | Tier | Run | What it does |
|--------|-----|------|-----|--------------|
| [backfill_missing_documents](backfill_missing_documents/) | — | prod-write | `ops run backfill_missing_documents` | Backfill invoices and credit notes for sales that never produced one: export CSV, upload to S3, run the task |
| [edit_document_payload](edit_document_payload/) 📄 *runbook* | — | prod-write | `ops orion script view edit_document_payload` | Runbook: hand-edit an accounting document's payload_base64 in an IEx shell and re-drive the send |
| [fix_credit_note_references](fix_credit_note_references/) 📄 *runbook* | SA · zatca | prod-write | `ops orion script view fix_credit_note_references` | Phase 2 of match_credit_notes_to_invoices: put the BillingReference onto the 34 rejected B2B credit notes |
| [force_retry_invoices](force_retry_invoices/) | — | prod-write | `ops run force_retry_invoices` | Force-retry stuck e-invoices: flip their trackers retry-eligible, then re-drive sending via Houston |
| [match_credit_notes_to_invoices](match_credit_notes_to_invoices/) | SA · zatca | read-only | `ops run match_credit_notes_to_invoices` | Map each B2B credit note to the invoice it credits, or decode a document's payload_base64 locally |
| [patch_invoice_payloads](patch_invoice_payloads/) | — | read-only | `ops run patch_invoice_payloads` | Decode an invoice's payload_base64 locally, patch it with an Elixir expression, emit the remediation runbook |
<!-- ops:end catalogue:production/write -->

## staging · write

<!-- ops:begin catalogue:staging/write -->
| Script | For | Tier | Run | What it does |
|--------|-----|------|-----|--------------|
| [confirm_comarch_uat_queue](confirm_comarch_uat_queue/) | SA · zatca | staging | `ops run confirm_comarch_uat_queue` | Process the Comarch UAT queue by confirming "sent" items via the edoc-online UAT REST API |
| [deregister_invopop_suppliers](deregister_invopop_suppliers/) | — | staging | `ops run deregister_invopop_suppliers` | Fire the Invopop supplier-deregistration workflow, one Transform job per supplier, in a sandbox workspace |
| [wipe_provider_einvoicing](wipe_provider_einvoicing/) | — | staging | `ops run wipe_provider_einvoicing` | Wipe all of a provider's e-invoicing rows from a staging accounting_documents DB in one transaction |
<!-- ops:end catalogue:staging/write -->

## Danger tiers

<!-- ops:begin tiers -->
- **Read-only** (`read-only`) — SELECTs and external GETs only; cannot write anywhere: `check_invopop_suppliers`, `lookup_invopop_receipt`, `match_credit_notes_to_invoices`, `patch_invoice_payloads`.
- **Prod writes (gated, reversible-ish)** (`prod-write`) — gated Houston tasks; dry run by default; requires a terminal: `backfill_missing_documents`, `force_retry_invoices`, `edit_document_payload` (runbook), `fix_credit_note_references` (runbook).
- **Staging / sandbox** (`staging`) — non-production only — the staging databases, the Invopop sandbox, Comarch UAT; refuses production, and some of it deletes rows: `confirm_comarch_uat_queue`, `deregister_invopop_suppliers`, `wipe_provider_einvoicing`.

Mode-by-mode nuance lives in each script's own `AGENTS.md`; the tier is the worst thing the script can do in any mode. `ops help tiers` has the long form.
<!-- ops:end tiers -->

## Retired

<!-- ops:begin retired -->
| Script | Retired | Why |
|--------|---------|-----|
| [audit_tax_identity_drift](audit_tax_identity_drift/) | 2026-09-10 | Written to survey tax-identity drift during the Billing Profiles rollout; that migration is complete (team-orion #282 and #296) and the survey has served its purpose |
| [it_credential_lifecycle_bugbash](it_credential_lifecycle_bugbash/) | 2026-09-10 | The bug bash it was written for ran on 2026-09-04 with all ten cases green; RENEWAL_EMAIL_GAP.md stays as the open question (team-orion#575) |
| [onboard_location_scripts](onboard_location_scripts/) | 2026-09-10 | The Billing Profiles migration it predates is complete (team-orion #282 and #296, 35/35 tickets), so its checks and task suggestions target a schema that no longer describes onboarding |
| [plugin_legal_entity_updates](plugin_legal_entity_updates/) | 2026-09-10 | It drove the Billing Profiles migration, which is complete including the plugin backfills (team-orion #300 and #463); nothing is left to migrate or link |

These are decommissioned. They are hidden from `ops orion script list` (use
`--status retired`) and `ops run` refuses them; the files still run directly if you
ever need them.
<!-- ops:end retired -->

## Prereqs (most scripts)

- **VPN up** + `houston` authenticated. Prod DB reads use the
  `fresha-production-developer` profile; some writes need a stronger role
  (e.g. `backfill_missing_documents` uploads to S3 with `fresha-production-team-orion`).
- Elixir/Erlang are pinned via `.tool-versions` (asdf); Node ≥ 20 on PATH.
  Elixir scripts that need deps auto-install them via `Mix.install` (e.g. `Req`);
  `backfill_missing_documents` and the Node scripts are dependency-free.
- Tokens (`INVOPOP_API_TOKEN`, `INVOPOP_SANDBOX_API_TOKEN`, `COMARCH_UAT_JWT`) come
  from the environment; the scripts prompt when one is unset. A script lists the
  ones it reads as `secrets:` in its frontmatter, and `ops run` asks for those
  once and passes them in from its git-ignored `.env` (`ops help credentials`).
- `ops orion doctor` checks the runtimes and the catalogue.

## Domains, countries and integrations

Every script declares a `domain`. It is what `ops orion script list` groups by
first, because which tax authority a tool talks to matters more than which
database it points at. Inside a domain the subsections are the `integration`: the
scheme, or failing that the `integrator`, or failing both `Any integration`, which
comes last and is not a gap to fix — a tool that serves every scheme says so by
leaving the field out. The environment is a column inside those tables, not a
heading of its own.

| domain | what belongs in it |
|---|---|
| `e-invoicing` | anything that talks to a tax authority, or to the documents on their way to one |
| `accounting-documents` | the documents themselves: generating them, backfilling them, onboarding for them |

An e-invoicing script also names the country it serves and how it gets there. The
`integration` is the scheme the country runs; the `integrator` is the vendor
Fresha reaches it through:

| country | integration | integrator |
|---|---|---|
| `SA` (KSA) | `zatca` | `comarch` |
| `ES` | `verifactu`, `ticketbai` | `invopop` |
| `IT` | `smart_receipts` | `invopop` |

All three are one value or none. A tool that is country-blind by design — payload
surgery that branches on whatever the document's country turns out to be, a
staging wipe that deletes rows whatever they are — leaves them out rather than
naming a country it does not actually mean. A tool that serves several countries
today is a tool waiting to be split into granular ones.

## Adding a new script

`ops orion script new <name> --lang {js|exs} --env {production|staging} --access {read-only|write}`
scaffolds the directory: an executable entrypoint with a shebang, `--help`, a
single readline interface and a dry-run default, plus an `AGENTS.md` whose
frontmatter already passes `ops orion docs check`. Then edit both and run
`ops orion docs sync` to add the row above.

Names say what the script does: verb first, then the object, snake_case, naming the
external system when more than one exists (Invopop, Comarch). The directory, the
entrypoint and the frontmatter `name` always agree.

By hand: one directory per script, a single executable entrypoint (`.exs` with
`#!/usr/bin/env elixir`, or `.js` with `#!/usr/bin/env node`) named after the
directory, and an `AGENTS.md` shaped like this:

```markdown
---
name: <dir name>                 # must equal the directory
summary: <one line, ≤ 110 chars, imperative, no trailing period>
domain: e-invoicing | accounting-documents        # required; the section it lands in
country: ES                      # ISO 3166-1 alpha-2, when the script is for one country
integration: verifactu           # the scheme that country runs (see the table below)
integrator: invopop              # who Fresha reaches it through
env: production | staging
access: read-only | write
tier: read-only | prod-write | prod-write-irreversible | prod-write-no-dry-run | staging
status: active | deprecated | retired | runbook | blocked   # default active; runbook/blocked = no script
lang: js | exs                   # active/deprecated only
also: [other_entrypoint.js]      # optional secondary executables in the directory
secrets: [SOME_TOKEN]            # env vars holding a credential: ops asks once and passes them in
help_flag: false                 # only if the script has no --help
examples:                        # ≥ 1 for an active script; args as typed after the script
  - args: "--dry-run 123"
    note: plan only
reports: [name-*.md]             # globs it writes to the cwd (feeds .gitignore)
related: [other_script]
blocked_on: <one line>           # status blocked only
retired_reason: <one line>       # status retired only, with retired_on: YYYY-MM-DD
---
# <name>

One paragraph on what it answers or changes and why it exists.

## What it does / ## Pipeline
## Safety
## Prereqs
## Output
```

The script's own `--help` owns its flags — do not repeat them in the document.
The frontmatter owns the summary, env, access, tier and examples. No
`## Run it` section and no `**Env:**` line: `ops orion docs check` warns on both.
