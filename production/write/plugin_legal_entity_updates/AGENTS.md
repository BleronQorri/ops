# plugin_legal_entity_updates

Link providers' e-invoicing plugins to their **primary legal entity**, by driving
the `link_plugins_to_legal_entities_from_env` Houston task.

## Just run it — it asks you everything

**Interactive by default.** You do not need to remember any flags:

```sh
./plugin_legal_entity_updates.js
```

## Four modes

Workflow order: **migrate → pre-flight → link → post-flight**.

| Mode | Question it answers | Service | Writes? | Exit 1 when |
|---|---|---|---|---|
| **migrate** | Create the legal entities in the first place | `partners-app` | yes, no dry run | a provider didn't migrate |
| **pre-flight** *(default)* | Is the data consistent, and does the legal entity carry everything the country requires? | — | never | any field differs, or a required field is missing (⛔ blocks e-invoicing) |
| **link** | *do* the linking | `accounting-documents` | only via apply | a row didn't land |
| **post-flight** | Is everything linked? each plugin's `legal_entity_id` vs its provider's primary | — | never | any link drift |

Pre-flight and post-flight are strictly `SELECT`s. Neither reaches a Houston
task; neither can write under any flag combination. Pre-flight doesn't even read
the plugins table — it has nothing to do with link state.

`--migrate`, `--preflight`, `--postflight` and `--verify` (an alias for
post-flight) skip the mode prompt. `--print-only` deliberately does *not* imply a
mode — it's valid in both migrate and link.

## The guided flow

| Step | Prompt | Default |
|------|--------|---------|
| 1 | **What do you want to do?** pre-flight / post-flight / link / migrate | **pre-flight** |
| 2 | **Which environment?** staging (`eng-orion`) / production / other namespace | staging |
| 3 | **Read from these databases?** — target shown, approved *before any query runs* | — |
| 4 | **Which providers?** every provider with an account configuration / a list you type | all |
| 5 | *(reads — every statement echoed before it runs)* | — |

**Pre-flight and post-flight stop here** with a `PASS`/`FAIL` verdict.
Link continues:

| Step | Prompt | Default |
|------|--------|---------|
| 6 | *(prints the resolution report + exempt roster)* | — |
| 7 | **Dry run or apply?** — asked with the report on screen | dry run |
| 8 | **Approve the run** — non-prod one `yes`; **production** makes you type the namespace back, *then* `yes` | — |
| 9 | *(prints the exact command, runs it, then verifies)* | — |

The first prompt defaults to **pre-flight** — a mode that cannot change anything.

Menus take the number, a name (`prod`, `staging`, `all`, `list`, `apply`), or
blank for the default. Every flag below is only a shortcut for pre-answering one
of these prompts — skip a flag and you simply get asked instead.

Running out of input (Ctrl-D, or a piped script one line short) **aborts**; it
never falls through to a default. Nothing is run.

## Nothing touches real data without your approval

Two properties, together, are what make that true:

**1. It requires a terminal.** If `stdin` is not a TTY the script refuses before
any query — exit 1, nothing read, nothing run:

```
Error: Refusing to touch real data without an interactive terminal.
  stdin is not a TTY, so approval could only come from a pipe or a script —
  and a piped "yes" is not explicit approval. Run this from a terminal.
```

A `yes` arriving down a pipe is an *automated* approval, which is exactly what
these gates exist to prevent. This also means cron, CI, or another script cannot
drive it. **There is deliberately no `--force`/`--yes` escape hatch.** Tests
allocate a real pty, or preload a harness module that fakes `isTTY` — that trick
lives in the test rig, never in the script.

**2. Reads are gated too, up front.** Before the first `psql` — before provider
discovery, before anything — the target is spelled out and confirmed:

```
── About to read real data ─────────────────────────────
  namespace : production   ⚠  PRODUCTION
  psql env  : production
  mode      : preflight   (read-only — cannot write)
  databases : shedul, accounting_documents, legal_entities
  access    : read-only SELECTs — no writes at this stage
Read from these databases? (type "yes"):
```

Production requires an exact `yes`; other namespaces also accept `y`. Declining
prints `Aborted. Nothing was read.` and exits without a single query.

So there are **two** approvals on a dry run and **three** on a production apply
(read gate → namespace echo → `yes`). `--print-only` and `--json` still pass the
read gate — they query real databases, so they are not exempt. `--json` prompts
on **stderr** so its stdout stays pure JSON.

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

4. **Billing info + legal entity fields** (pre-flight only) — `provider_billing_informations`
   from shedul, and the legal entity's jsonb `fields` from `legal_entities`. See
   [Pre-flight](#pre-flight--is-the-data-consistent) for the shape.

All are plain `SELECT`s. The only write in the whole script is the Houston task,
behind the confirmation gate — and only in link mode.

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

## Exempt providers

Anything not resolvable is listed in an **Exempt providers** table — provider,
how many plugins it has, their IDs, and why it was passed over. The roster is
always printed, so the exempt set is explicit rather than something you infer
from what's missing. The short reasons in that column mean:

| Reason (as printed) | Meaning |
|--------|---------|
| `no active primary legal entity (RPC would answer NOT_FOUND)` | no `valid_to IS NULL` row in `provider_purchases_primary_legal_entities` |
| `no plugins — provider has no e-invoicing config yet` | nothing in `account_configuration_plugins` for it |
| `already linked to this legal entity` | a plugin already holds this exact `legal_entity_id` |
| `all plugins already have a legal_entity_id (never overwritten)` | set, but to something else — the task never overwrites |
| `N unlinked plugins — ambiguous, pick one by hand` | more than one candidate; the unique index allows only one |

If two providers in one batch resolve to the **same** legal entity, that's a
unique-index collision: it's flagged with a `⚠`, and the task will apply one and
skip the rest. The verification pass below is what catches which one lost.

## Migrate — create the legal entities

The first step of the workflow, and the one everything else depends on: without a
legal entity and a primary pointer there is nothing to compare or link.

```sh
./plugin_legal_entity_updates.js --migrate 12345,67890
./plugin_legal_entity_updates.js            # then pick 4
```

Runs, on the **`partners-app`** service (not accounting-documents):

```sh
houston task run partners-app --namespace eng-orion \
    legal_entities_migration:migrate \
    -p PROVIDER_IDS=12345,67890 \
    -p MIGRATE_PAYMENT_METHODS="true"
```

`app-shedul/src/lib/tasks/legal_entities_migration.rake` →
`legal_entities_migration.rb` (`LegalEntitiesMigration`). Per provider it
classifies and dispatches to `billing_only`, `adyen_fresha_pay` or
`checkout_fresha_pay`, creating the legal entity and setting it primary.

**Explicit provider list only.** No `--all`, no `COUNTRY_CODES`, no
`PROVIDER_IDS_CSV_URL` — the task supports the latter two, but "every provider
with an account configuration" is the wrong set for a migration and a stray Enter
must not migrate everything. `--all`, `--file` and `--json` are rejected with an
error rather than silently ignored.

### Three things about this task that shaped the design

1. **There is no `DRY_RUN`.** Unlike the link task, it writes on the first call.
   So the stand-in is a read-only preview of where each provider stands, printed
   before the gate:

   ```
   PROVIDER  CC  FRESHA_PAY  MIGRATION TYPE       STATUS     LEGAL ENTITY  WHAT WILL HAPPEN
   201       IT  0           —                    —          —             new — will migrate
   202       IT  0           billing_only         confirmed  aaaa2222…     already confirmed — re-run resumes, no duplicate
   203       ES  1           adyen_fresha_pay     failed     ∅             previously failed — will retry
   204       IT  0           billing_only         migrated   aaaa4444…     partially migrated — will resume
                             checkout_fresha_pay  pending    ∅
   999       —   —           —                    —          —             ⚠ provider not found in providers
   ```

   A provider can hold one `billing_migration_statuses` row per `migration_type`,
   so the join legitimately fans out — every row is shown. `MIGRATION TYPE` and
   `STATUS` are what's already *recorded*; for a provider with no row the branch
   is decided server-side by `resolve_migration_type` (plus the `fresha_pay`
   nil/`not_set` → `billing_only` special case), so `CC` and `FRESHA_PAY` are
   shown as the inputs rather than a guessed outcome.

2. **It is resumable.** `ensure_legal_entity_created` returns early when the
   status is already `migrated`, `find_or_create_status` reuses an existing row,
   and the blast-marketing update only claims rows whose `legal_entity_id IS
   NULL`. A re-run resumes rather than duplicating — which is why "already
   confirmed" is not treated as an error.

3. **`MIGRATE_PAYMENT_METHODS=true` has an external side effect** — card-on-file
   migration through an RPC (`PaymentMethodMigration`). It defaults to true here,
   matching how the task is invoked in practice, and the gate says so explicitly.
   `--no-payment-methods` turns it off.

Only the provider IDs are prompted for. `COPY_TAX_NUMBER` and `BATCH_SIZE` stay
at the task's own defaults (`false`, `100`), overridable by flag but never asked.

### Read-back

Same principle as link mode — the task exits 0 even when individual providers
fail, so the exit code proves nothing. The migration state is re-read afterwards
and shown as a before → after transition:

```
   PROVIDER  BEFORE                            AFTER      LEGAL ENTITY  RESULT
✓  201       new — will migrate                confirmed  aaaa1111…     migrated
✗  203       previously failed — will retry    failed     ∅             FAILED — see task logs
✓  204       partially migrated — will resume  confirmed  aaaa4444…     migrated
```

Ends in `MIGRATE: PASS` / `FAIL`. Exits 1 if any requested provider still has no
status row or sits at `failed`.

## Verification

The post-flight and link modes.

Two forms: a standalone audit you can run any time, and an automatic read-back
after an apply.

### Post-flight — is everything linked?

Pick it at the first prompt, or `--postflight` (`--verify` still works). Answers
"is this namespace correctly linked *right now?*" Runs no task, prints no
command, writes nothing:

```sh
./plugin_legal_entity_updates.js --postflight --all
```

```
   PROVIDER  PLUGIN  EXPECTED (primary LE)  ACTUAL (plugin LE)  STATUS
─  ────────  ──────  ─────────────────────  ──────────────────  ─────────────────────────────────────────
✓  18        1       019fa326-f225…         019fa326-f225…      linked correctly
–  102       —       019f…                  —                   no plugins — no e-invoicing config
✗  104       —       019f…                  —                   not linked — 2 candidates
✗  106       9007    019f…-666              019f…-999           MISMATCH — holds a different legal entity
✗  107       9008    019f…-aaa              ∅                   not linked
```

| Symbol | State | Meaning |
|---|---|---|
| `✓` | ok | the plugin holds its provider's primary legal entity |
| `–` | exempt | nothing to check — no primary LE, or no plugins |
| `✗` | drift | not linked, ambiguous, or linked to the *wrong* legal entity |

Ends with a `POST-FLIGHT: PASS` / `FAIL` banner and exits **1** on drift, so it
works as a runbook gate. For data consistency rather than link state, run
pre-flight.

It costs no extra queries — the plugin read already returns `legal_entity_id`, so
this is pure comparison over what the script fetches anyway.

**A `MISMATCH` is not something this script fixes.** The task only fills NULLs and
never overwrites, so a plugin pointing at the wrong legal entity needs a human
decision. Plain `not linked` rows are just pending work: re-run without `--verify`
and choose apply.

### Pre-flight — is the data consistent?

The default mode, and the one to run *before* linking anything. Being linked to a
legal entity says nothing about whether the two sides hold the same data, so
pre-flight diffs `provider_billing_informations` (shedul) against the legal
entity's fields (`legal_entities`), for every provider that has an account
configuration:

```sh
./plugin_legal_entity_updates.js --preflight --all
```

```
  ✓ provider=18  7/7 comparable fields match
  – provider=52  no active provider_billing_informations row — nothing to compare

  ✗ provider=35  3/8 match — 5 differ:
      FIELD           PROVIDER BILLING INFO         LEGAL ENTITY  NOTE
      tax / VAT no.   B63272603                     ∅             missing in legal entity
      street          Carrer d'Entença 332 6º - 6º  ∅             missing in legal entity
      city            Barcelona                     ∅             missing in legal entity
```

Only providers that actually differ get a table — the rest are one line each.

### The field-by-field checklist

When you name providers explicitly, pre-flight *also* prints a full checklist per
provider — every field, matching or not, with the legal-entity key that supplied
the value:

```
── provider=33 (organization) ─────────────────────────
REQUIRED FIELD    PROVIDER BILLING (shedul)  LEGAL ENTITY (fields jsonb)                        PRESENT?
legal name        My business                organization.legalName = My business                ✅ both
tax / VAT no.     311268874200003            organization.vatNumber = 311268874200003            ✅ both
registration no.  7394826150                 organization.registrationNumber = 7394826150        ✅ both
street            Al Faisaliyyah             organization.registeredAddress.street = …           ✅ both
country           SA                         organization.registeredAddress.country = SA         ✅ both
building number   1234                       —                                                   provider only
district          1234                       —                                                   provider only

  ✓ 8/8 comparable fields agree   (2 provider-only column(s) shown for completeness, not compared)
```

| `PRESENT?` | Meaning |
|---|---|
| `✅ both` | on both sides and equal |
| `❌ differs` | on both sides, values disagree |
| `⚠ provider only` | in billing info, absent from the legal entity |
| `⚠ legal entity only` | in the legal entity, absent from billing info |
| `provider only` (plain) | a billing-info column with **no** legal-entity counterpart — see below |

**Defaults by intent**, so neither use is noisy: naming providers means you're
inspecting them, so you get the checklists; `--all` is a bulk sweep, so you get
one line each. `--detail` and `--summary` force either way.

### Required fields per e-invoicing country

Pre-flight knows what app-accounting-documents will actually demand, so it can
tell a cosmetic difference from something that **blocks e-invoicing**. Both
validators fetch the legal entity via `GetLegalEntityInvoiceDetails` and hard-fail
with `{:error, :missing_required_fields}`:

| Field | ES / IT | KSA (SA) |
|---|---|---|
| `company_name` | **required** | not checked — taken from the request |
| `address` (street), `city`, `postal_code`, `state_province` | required | required |
| `tax_number` | required — `TAX_IDENTIFICATION_NUMBER` | required — `TAX_NUMBER` (ZATCA TRN) |
| `company_registration_number` | — | **required** |
| `building_number`, `district` | — | **required** |
| `country_code` | not checked | not checked |

- `SA` → `AccountingDocuments.EInvoicing.Comarch.LegalEntityBillingDetails` `@required_fields`
- `ES` / `IT` → `AccountingDocuments.EInvoicing.Common.LegalEntityBillingDetails` `@required_fields`

The country comes from **`account_configurations.country_code`**, because that's
what `BillingDetailsPolicy` dispatches on (`%{country_code: "SA"} =
account_configuration`) — not the billing info's country, and not the legal
entity's. Countries with no entry have no required set, and the comparison stays
purely informational for them.

A required field missing on the **legal-entity** side is reported as
`⛔ BLOCKS e-invoicing` and fails the run. That's stronger than "differs": the
onboarding/send path will refuse the provider outright.

Note the KSA `tax_number` is a *different identifier kind* — present-and-equal
here is necessary but not sufficient, since the ZATCA TRN and the ES/IT NIF/PIVA
come from different `IDENTIFIER_KIND_*` entries.

### Provider-only columns

**`building_number`, `district` and `company_number`** are
`provider_billing_informations` columns that usually have no legal-entity
equivalent, so they're marked *informational* — "provider only" is the designed
state and doesn't count toward the verdict.

**Except for SA.** `fields_configuration/country/sa.ex` defines
`registeredAddress.buildingNumber` (4-digit) and `.district` with
`is_required: true`, commented *"required, as ZATCA e-invoicing needs a complete
seller address"*, and `InvoiceParty.Address` reads exactly those keys. So when the
country's required set names a field, the informational exemption is dropped and a
missing value blocks. The default config has neither key and uses
`registeredAddress.street2` instead.

`company_number` has no counterpart anywhere and is always informational.

When nothing matched, the key column still names the key this entity *would* use
— `individual.residentialAddress.street` for an individual, not the organization
key — so an empty value reads as missing data rather than a wrong lookup.

**Where the values come from.** `legal_entities` doesn't store this in columns:
it keeps a jsonb array of `{key, value}` (see `LegalEntities.Schemas.Field`), so
the query unnests `fields` and the script looks up dotted keys.

| Field | provider_billing_informations | legal entity key |
|---|---|---|
| legal name | `company_name` | `organization.legalName`, `trust.name` |
| first / last name | `first_name`, `last_name` | `individual.name.firstName` / `.lastName` |
| tax / VAT no. | `tax_number` | `organization.vatNumber`, `organization.taxInformation.number` |
| registration no. | `company_registration_number` | `organization.registrationNumber` |
| activity code | `activity_code` | `organization.activityCode` |
| street / city / postal / state | `address`, `city`, `postal_code`, `state_province` | `…registeredAddress.*` or `…residentialAddress.*` |
| building no. / district / company no. | `building_number`, `district`, `company_number` | *(none — provider only)* |
| country | `country_code` | `…registeredAddress.country`, else the `country_code` column |

Several keys can carry the same fact and which one is populated varies by country
and entity type — `tax_number` lands in `organization.vatNumber` for IT but
`taxInformation.number` elsewhere — so candidates are tried in order and the
first non-empty one wins.

**Two things stop this producing noise:**

1. **Type awareness.** `provider_billing_informations` always carries a contact
   person's first/last name, while an *organization* legal entity has no
   `individual.*` fields at all. Comparing them would report every organization
   as "first name missing". So person-name fields are only compared for
   `individual` entities, and company fields only for the rest.
2. **Normalised comparison.** Values are trimmed, internal whitespace collapsed,
   and casefolded before comparing — displayed raw, matched on meaning.

A field where *both* sides are empty isn't comparable and is skipped entirely.

**The verdict.** A field difference is a **FAIL** — the whole point of a
pre-flight is to say whether the data is fit to proceed on, and two systems
disagreeing about a legal name or a tax number is exactly what you want to know
before linking. Providers with no billing row or no primary legal entity are
**warnings, not failures**: they have nothing to be inconsistent about.

```
══ PRE-FLIGHT: FAIL ════════════════════════════════════
  ✗ 2 provider(s) where billing info and the legal entity disagree.
  ⚠ 3 skipped: 3 with no billing row, 0 with no primary legal entity.
```

The script never edits either side — reconciling a difference is a human call.

### Automatic read-back after an apply

After the task runs, the script **reads the rows back** and prints a table:

```
PLUGIN  PROVIDER  LEGAL ENTITY APPLIED                  VERIFIED BY  RESULT
──────  ────────  ────────────────────────────────────  ───────────  ─────────────────────────────
9001    101       11111111-1111-4111-8111-111111111111  ✓ read-back  matches intended legal_entity_id
9009    108       aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa  ✗ read-back  still NULL — task skipped it …
```

**Why this exists:** the Houston task exits `0` even when it skips every single
row. `BackfillAccountConfigurationPluginLegalEntityIdAction` logs `[skipped]` per
entry and carries on — a green exit is not evidence that anything was written.
Only re-reading `account_configuration_plugins.legal_entity_id` proves it.

Verdicts:

| Result | Meaning |
|--------|---------|
| `matches intended legal_entity_id` | written and correct |
| `unchanged, still NULL — correct for a dry run` | dry run behaved (this is the *expected* pass under `DRY_RUN=true`) |
| `still NULL — task skipped it` | apply didn't land, usually a unique-index collision |
| `holds a different legal entity: <uuid>` | pre-existing value, not overwritten |
| `dry run but row is set to <uuid>` | a dry run wrote something — should be impossible; investigate |
| `plugin row not found on read-back` | the plugin disappeared between resolve and verify |

Any failure makes the script exit **1** and print `✗` instead of `✓`, so it won't
report success on a partial result.

It also prints a **cross-check** block: the two `houston psql` commands to run
yourself — what the plugins now hold, and what they *should* hold straight from
`provider_purchases_primary_legal_entities`. The two provider→LE sets must be
identical. Re-running the script is the other check: everything should come back
as `already linked`, 0 updates.

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
#       --migrate          run legal_entities_migration:migrate on partners-app
#       --no-payment-methods   MIGRATE_PAYMENT_METHODS=false (default true)
#       --copy-tax-number      COPY_TAX_NUMBER=true (default false)
#       --batch-size N         BATCH_SIZE=N (task default 100)
#       --verify           audit only — report link state, run nothing, exit 1 on drift
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

- **Requires a terminal** — no TTY, no run. A piped `yes` is not approval, and
  there is no `--force`.
- **Reads are approved before any query**, with the namespace and databases
  shown.
- **Dry run is the default** at every level: the prompt defaults to it, and
  omitting `--apply` emits `DRY_RUN="true"`.
- The exact command is printed **before** the confirmation, and echoed again
  before the spawn.
- **Production takes two gates:** type the namespace back, then an exact `yes`
  (non-prod accepts `y`).
- The underlying action never overwrites a non-NULL `legal_entity_id`, so a
  re-run is idempotent.
- End-of-input aborts rather than accepting a default.
- **Post-run read-back** — success is never claimed on the task's exit code
  alone; a row that didn't land makes the script exit 1.

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
- Needs psql access to **three** databases in the target namespace — `shedul`,
  `accounting_documents` and `legal_entities` — plus permission to run Houston
  tasks on **both** `accounting-documents` (link) and `partners-app` (migrate). (In staging all three are hosted on the same RDS instance,
  `<namespace>-shedul`; the alias still selects the database.)

## Output

Colour follows the convention in `onboard_location_scripts.exs`: **cyan** for a
query about to run, **yellow** for a command you could run yourself, **bright
white** for section headers, **faint** for progress. Every statement is echoed
before it runs — this script reads production, so what it asks for should never
be a mystery. Long `IN (…)` lists are truncated in the echo.

Colour is suppressed when stdout isn't a terminal, or when `NO_COLOR` is set.
