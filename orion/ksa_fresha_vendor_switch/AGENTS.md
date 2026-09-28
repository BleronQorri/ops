---
name: ksa_fresha_vendor_switch
summary: Move Fresha's Saudi entity between Comarch and Invopop, one checked houston step at a time
domain: e-invoicing
country: SA
integration: zatca
env: production
access: write
tier: prod-write
lang: js
examples:
  - args: "onboard-invopop --branch-name \"Fresha KSA\" --business-category Software"
    note: checks, the onboarding dry run and the plan; writes nothing
  - args: "onboard-invopop --execute --branch-name \"Fresha KSA\" --business-category Software"
    note: the one-time move to Invopop, each write confirmed, the OTP asked for
  - args: "to-comarch"
    note: the fallback, planned — the flip dry run and the refused invoices it would resubmit
  - args: "to-comarch --execute"
    note: flip to Comarch, pick the refused invoices, resubmit them, report their trackers
  - args: "to-invopop --execute"
    note: flip back once the cause is fixed; refuses without an Invopop registration
  - args: "--namespace eng-orion to-invopop"
    note: rehearse against the simulation account
related: [lookup_sa_zatca_document, force_retry_invoices]
---
# ksa_fresha_vendor_switch

Fresha's own Saudi invoices and credit notes can go to ZATCA through Comarch or
through Invopop, and which one is the `integrator` column of the entity's default
e-invoicing plugin — the router reads it at send time and every resend follows it
(team-orion#953). Moving between the two is a fixed order of runner tasks and
checks. This script walks the operator through that order, one step at a time,
and stops on the first check that fails (team-orion#955).

## What it does

**`onboard-invopop`** — the one-time move.

1. Read the configuration (the SA one keyed on an `invoice_entity_id`) and its
   plugin. Stop unless it is `comarch` / `enabled`.
2. Stop if any of the entity's documents is not `sent` / `approved`, or a
   periodic invoice is waiting for submission — the batch must have cleared.
3. Dry-run `onboard_fresha_entity_to_ksa`. While Comarch is on, the task answers
   `already_onboarded`: that is the expected answer, and it means the Fresha
   billing entity read cleanly from Partners. Any other refusal stops.
4. Print what Comarch holds (VAT number, CRN, address) and ask the operator to
   confirm the Partners billing entity matches — ZATCA must see one supplier. The
   task's dry run does not print the party itself, so the comparison is by hand.
5. `update_account_configuration_plugin_status` with `PLUGIN_STATUS=disabled` and
   `THIRD_PARTY_INTEGRATION_STATUS=disabled` — the onboarding only re-registers a
   plugin whose third-party status is off. Read back.
6. Dry-run the onboarding again (now it plans the re-registration), ask for the
   FATOORA OTP and run it for real.
7. Poll the plugin until it is `invopop` / `enabled`, or report `failed` with the
   registration request's fault.

If anything stops the run between 5 and 6 while the plugin is still Comarch's, it
offers to enable it again, since a disabled plugin means Fresha documents are
skipped.

**`to-comarch`** — the fallback.

1. Stop unless the plugin is `invopop` / `enabled`.
2. The #954 flip task as a dry run, then for real with `INTEGRATOR=comarch`; read
   back the plugin (still `enabled`) and the new plugin log line.
3. List the entity's refused periodic invoices (draft, `e_invoice_rejected_at`
   set); the operator may leave any out.
4. `resubmit_einvoice_for_periodic_invoices` as a dry run, then for real.
5. Report the tracker each resubmitted document got since the run started,
   waiting up to `--wait-minutes` for ZATCA's verdict.

Documents that failed before the send need nothing: the retry cron resends them,
through Comarch after the flip.

**`to-invopop`** — back after a fix.

1. Stop unless the plugin is `comarch` / `enabled` and the entity has an
   approved `register` request carrying a Silo entry.
2. The flip task as a dry run, then for real with `INTEGRATOR=invopop`. The
   onboarding is never run again.

## Safety

- Dry run by default: every mode reads, checks and runs the tasks' own dry runs,
  and prints the writes it would make. `--execute` runs them, each after a typed
  `yes`, and needs a terminal.
- Reads are `houston psql` only; every write is a houston runner task.
- A task's exit code is not taken as proof: `run/2` in the runner exits 0 whatever
  the task returned, so after each write the plugin or the documents are read back.
- `resubmit_einvoice_for_periodic_invoices` defaults to `DRY_RUN=false`; the
  script always passes `DRY_RUN` explicitly.
- The flip task is team-orion#954. Until it merges under its expected name
  (`update_account_configuration_plugin_integrator`), `--flip-task` names it.

## Prereqs

- Node ≥ 20 on PATH (no dependencies). VPN up, `houston` authenticated.
- A FATOORA OTP for `onboard-invopop`, generated just before the step asks for it.

## Output

- Each step and what it read or ran, on stdout; the tasks' own output streams through.
- Exit 0 done, 1 a check failed, a resubmitted document did not clear, or the
  operator stopped it, 2 the call was wrong or houston could not answer.
