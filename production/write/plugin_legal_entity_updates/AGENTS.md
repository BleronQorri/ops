# plugin_legal_entity_updates

Link providers' e-invoicing plugins to their **primary legal entity**, by driving
the `link_plugins_to_legal_entities_from_env` Houston task.

## Just run it — it asks you everything

**Interactive by default.** You do not need to remember any flags:

```sh
./plugin_legal_entity_updates.js
```

It walks you through the whole thing:

| Step | Prompt | Default |
|------|--------|---------|
| 1 | **Which environment?** staging (`eng-orion`) / production / other namespace | staging |
| 2 | **Which providers?** every provider with an account configuration / a list you type | all |
| 3 | *(reads both DBs, prints the resolution report)* | — |
| 4 | **Dry run or apply?** — asked with the report on screen | dry run |
| 5 | **Confirm** — non-prod one `yes`; **production** makes you type the namespace back, *then* `yes` | — |
| 6 | *(prints the exact command, then runs it)* | — |

Menus take the number, a name (`prod`, `staging`, `all`, `list`, `apply`), or
blank for the default. Every flag below is only a shortcut for pre-answering one
of these prompts — skip a flag and you simply get asked instead.

Running out of input (Ctrl-D, or a piped script one line short) **aborts**; it
never falls through to a default. Nothing is run.

## What it reads

1. **Providers** (only when you don't name them) — `houston psql <env> accounting_documents`:

   ```sql
   SELECT DISTINCT provider_id FROM account_configurations
   WHERE provider_id IS NOT NULL ORDER BY provider_id;
   ```

   `NULL provider_id` rows — migrated configs that link only through
   `invoice_entity_id` — can't be resolved here, so they're excluded.

2. **Primary legal entity** — `houston psql <env> shedul`:

   ```sql
   SELECT provider_id, legal_entity_id
   FROM provider_purchases_primary_legal_entities
   WHERE provider_id IN (…) AND valid_to IS NULL;
   ```

3. **Plugins** — `houston psql <env> accounting_documents`:

   ```sql
   SELECT ac.provider_id, p.id, p.plugin_type, p.integrator, p.plugin_status,
          coalesce(p.legal_entity_id::text, '')
   FROM account_configuration_plugins p
   JOIN account_configurations ac ON ac.id = p.account_configuration_id
   WHERE ac.provider_id IN (…)
   ORDER BY ac.provider_id, p.id;
   ```

All three are plain `SELECT`s. The only write is the Houston task, behind the
confirmation gate.

## Where the data lives

`provider_purchases_primary_legal_entities` is in the **shedul** DB — *not*
legal-entities. Legal entities themselves live in app-legal-entities (no FK,
cross-service), but this provider→primary pointer is owned by shedul:

- `app-shedul/src/db/structure.sql` — the table
- `app-shedul/src/app/models/provider_purchases_primary_legal_entity.rb` — `scope :active`
- `app-shedul/src/app/services/rpc/action/get_primary_legal_entity_id_for_provider_action.rb`
- `app-shedul/src/lib/areas/legal_entities.rb` — `get_primary_legal_entity_for_provider_purchases`

Step 2's SQL is exactly what the `get_primary_legal_entity_id_for_provider` v1
RPC does. A partial unique index on `provider_id WHERE valid_to IS NULL` means at
most one active row; superseded rows keep `valid_to` set as a history trail. The
RPC answers `NOT_FOUND` when there is no active row — here that provider is
reported as skipped.

The `.pb.ex` under `app-legal-entities/src/apps/legal_entities/lib/generated/rpc/partners/…`
is the generated **client** stub: legal-entities is a *caller* of this RPC, not
the owner of the data.

## Which plugin gets picked

`account_configuration_plugins_legal_entity_id_uniq_index` makes
`legal_entity_id` globally unique among plugins where it is `NOT NULL` — so a
legal entity can back **at most one** plugin. The script therefore only proposes
plugins whose `legal_entity_id IS NULL`, and never guesses when there is more
than one.

A provider is **skipped** (with the reason printed, plus every plugin it has) when:

| Reason | Meaning |
|--------|---------|
| no active primary legal entity | no `valid_to IS NULL` row — the RPC would answer `NOT_FOUND` |
| no `account_configuration_plugins` | provider has no e-invoicing config yet |
| already linked | a plugin already holds this exact `legal_entity_id` |
| every plugin already has a `legal_entity_id` | never overwritten by the task |
| N plugins have a NULL `legal_entity_id` | ambiguous — pick one by hand |

If two providers in one batch resolve to the **same** legal entity, that's a
unique-index collision: it's flagged with a `⚠`, and the task will apply one and
skip the rest.

## The task it drives

`AccountingDocumentsRunner.EInvoicing.Common.Tasks.LinkPluginsToLegalEntitiesFromEnvTask`
→ `BackfillAccountConfigurationPluginLegalEntityIdAction`, which only sets
`legal_entity_id` where it is currently `NULL` — existing values are never
overwritten, so the task is idempotent and safe to re-run. It logs one line per
entry tagged `[applied]`, `[dry_run]`, or `[skipped]`.

The command is printed in paste-able form before it runs:

```sh
houston task run accounting-documents --namespace eng-orion \
    link_plugins_to_legal_entities_from_env \
    -p UPDATES='[{"plugin_id":9001,"legal_entity_id":"3fa85f64-5717-4562-b3fc-2c963f66afa6"}]' \
    -p DRY_RUN="true"
```

When the script runs it itself, it appends `--no-tui -w` so the task's logs
stream into your terminal; the full argv is echoed before the spawn.

## Flags (all optional — each just skips a prompt)

```sh
./plugin_legal_entity_updates.js [provider_ids]
#   -n, --namespace NAME   namespace / env; drives the psql env AND the task's --namespace
#       --all              every provider in account_configurations
#   -f, --file PATH        read provider IDs from a file (# starts a comment)
#       --apply            DRY_RUN="false" — actually write
#       --dry-run          DRY_RUN="true" — logs only (the default)
#   -s, --service NAME     Houston service (default: accounting-documents)
#       --print-only       print the command and stop; run nothing
#       --json             print only the UPDATES JSON array; never prompts, so it
#                          needs provider IDs or --all
#   -h, --help             help
```

IDs may be comma- or whitespace-separated, and are deduped.
`--json` makes it pipeable — payload on stdout, skip count on stderr.

## Safety

- **Dry run is the default** at every level: the prompt defaults to it, and
  omitting `--apply` emits `DRY_RUN="true"`.
- The exact command is printed **before** the confirmation, and echoed again
  before the spawn.
- **Production takes two gates:** type the namespace back, then an exact `yes`
  (non-prod accepts `y`).
- The underlying action never overwrites a non-NULL `legal_entity_id`, so a
  re-run is idempotent.
- End-of-input aborts rather than accepting a default.

## Implementation note: prompting

This script uses a **single** readline interface with its own line queue, unlike
the older scripts here which open and close one per question. That older pattern
silently loses answers as soon as you ask more than one thing in a row:

1. Closing an interface consumes the rest of the stream, so the next prompt on a
   piped stdin reads EOF and never resolves.
2. `rl.question` only captures a line if it's already awaiting one — on a pipe,
   readline emits buffered lines immediately, so anything arriving between
   prompts is dropped.

`ask()` therefore listens for `line` once and queues what arrives. `closeRl()`
runs before spawning Houston (which needs stdin for its own prompts) and in a
`finally` at exit. If you add prompts, keep using `ask()`.

## Prereqs

- VPN up; `houston` authenticated (prod reads use `fresha-production-developer`).
- Node on PATH. Dependency-free.
- Needs psql access to **both** `shedul` and `accounting_documents` in the target
  namespace, plus permission to run Houston tasks there.
