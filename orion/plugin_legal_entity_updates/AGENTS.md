---
name: plugin_legal_entity_updates
summary: "Link e-invoicing plugins to their primary legal entity: report, migrate, pre-flight, link, post-flight"
env: production
access: write
tier: prod-write-no-dry-run
status: retired
retired_on: 2026-09-10
retired_reason: "It drove the Billing Profiles migration, which is complete including the plugin backfills (team-orion #300 and #463); nothing is left to migrate or link"
lang: js
aliases: [ple]
examples:
  - args: ""
    note: "interactive; guided mode walks the whole procedure"
  - args: "--preflight --all --json --yes"
    note: read-only, no terminal needed
  - args: "--postflight --all --json --yes | jq .verdict"
  - args: "--link --dry-run 33"
    note: rehearse linking provider 33
reports: ["preflight-*.md", "rollout-report-*.md"]
---
# plugin_legal_entity_updates

Link providers' e-invoicing plugins to their **primary legal entity**, by driving
the `link_plugins_to_legal_entities_from_env` Houston task.

## Just run it — it asks you everything

**Interactive by default.** You do not need to remember any flags:

```sh
./plugin_legal_entity_updates.js
```

## Guided — the whole procedure, step by step

If you don't remember the order or what each step is for, pick **Guided** (option
1, the default, or `--guided`). It prints the procedure — every step, what it does,
why it exists, and what to watch for — then walks you through **pre-flight → link
→ post-flight**, letting you run, skip or stop at each:

```sh
./plugin_legal_entity_updates.js --guided 33
```

Every flag is optional: run the script bare and each one becomes a prompt instead.
Flags exist so a caller who already knows what it wants — including a non-human
one — can answer in advance. See [Arguments](#arguments) for the full list, and
**Running this yourself** below for the one thing flags cannot buy.

Guided runs each step as a child process and hands it the step, namespace and
provider list through `PLE_STEP` / `PLE_NAMESPACE` / `PLE_PROVIDERS` environment
variables. That is internal plumbing, not an interface: set them by hand and you
are simply pre-answering prompts, with nothing checking that you meant to.

## The guided flow

| Step | Prompt | Default |
|------|--------|---------|
| 1 | **What do you want to do?** guided / migrate / pre-flight / link / post-flight / plugin audit / reset — each tagged with the stage it belongs to | **guided** |
| 2 | **Which environment?** staging (`eng-orion`) / production / other namespace | staging |
| 3 | **Read from these databases?** — target shown, approved *before any query runs* | yes (**cancel** in production) |
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

The first prompt defaults to **guided** — the one mode that explains itself, so it is
the right landing place if you don't already know the order. The remaining options
are listed in workflow order (migrate → pre-flight → link → post-flight) and each
carries its stage and a one-line description, so the menu teaches the procedure
rather than listing verbs.

Menus take the number, a name (`prod`, `staging`, `all`, `list`, `apply`), or
blank for the default. Every flag below is only a shortcut for pre-answering one
of these prompts — skip a flag and you simply get asked instead.

Running out of input (Ctrl-D, or a piped script one line short) **aborts**; it
never falls through to a default. Nothing is run.

## Nothing touches real data without your approval

Two properties, together, are what make that true:

**1. Writing requires a terminal.** If `stdin` is not a TTY, every mode that can
write refuses before any query — exit 2, nothing read, nothing run:

```
Error: Refusing to write without an interactive terminal.
  --yes covers read-only modes only, and "migrate" writes.
  Run it from a terminal, or use a read-only mode with --yes:
    --preflight / --postflight / --plugins / --link --dry-run
```

A `yes` arriving down a pipe is an *automated* approval, which is exactly what
these gates exist to prevent, so **no flag can supply one.** `--yes` is not
`--force`: it is refused at the write confirmation itself, not merely absent from
it, so a future refactor that let a write reach that gate unattended would fail
loudly rather than approve itself.

What `--yes` does open is the read-only half — `--preflight`, `--postflight`,
`--plugins`, and `--link --dry-run`, none of which can write under any combination
of flags. Refusing those without a TTY bought no safety and made the script
unusable by anything but a person; see
[Running this yourself](#running-this-yourself-agents-ci).

The boundary is **"can this mode write?"**, not "is this production?" — a
read-only mode is safe in prod, and a write is not safe in staging just because it
is staging.

**2. Reads are gated too, up front.** Before the first `psql` — before provider
discovery, before anything — the target is spelled out and confirmed:

```
── About to read real data ─────────────────────────────
  namespace : production   ⚠  PRODUCTION
  psql env  : production
  mode      : preflight   (read-only — cannot write)
  databases : shedul, accounting_documents, legal_entities, adyen_platform
  access    : read-only SELECTs — no writes at this stage

Read from these databases?
  1) Yes — run the reads
  2) Cancel — nothing is read   [default]
  >
```

A numbered menu like every other decision: `1` confirms, and `yes` / `y` still
work. The default is where production differs — as above, production defaults to
**cancel**, so a bare Enter reads nothing and it takes a deliberate keystroke to
query prod; every other namespace defaults to **yes**. Declining prints
`Aborted. Nothing was read.` and exits without a single query.

So there are **two** approvals on a dry run and **three** on a production apply
(read gate → namespace echo → `yes`). Every mode passes the read gate, including
the read-only ones — they query real databases, so they are not exempt.

## What it reads

1. **Providers** (only when you don't name them) — `houston psql <env> accounting_documents`:

   ```sql
   SELECT DISTINCT provider_id FROM account_configurations
   WHERE provider_id IS NOT NULL ORDER BY provider_id;
   ```

   `NULL provider_id` rows are the **Fresha B2B account** — the configuration that
   releases Fresha's own B2B invoices, not a provider. Everything here keys on
   `provider_id`, so it's excluded from every mode. Whether it needs a legal entity
   of its own is an open question; `--report` prints a banner about it.

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

   Billing info is read for **every** provider in the batch, not only those with a
   primary legal entity. The providers without one are the reason: `migrate` builds
   the entity from that table, so whether the row exists is what separates "waiting
   for `migrate`" from "`migrate` would have nothing to build from".

All are plain `SELECT`s. The only write in the whole script is the Houston task,
behind the confirmation gate — and only in link mode.

`--report` is the one mode that reads **all** of the above in a single pass, each
table exactly once, plus `providers.fresha_pay` and the KYC link. That is why it
exists as its own mode rather than a flag on pre-flight.

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
| `no active primary legal entity (RPC would answer NOT_FOUND)` | no `valid_to IS NULL` row in `provider_purchases_primary_legal_entities`. Pre-flight goes further and says *why* it matters — whether the provider is waiting for `migrate`, or has no billing row for `migrate` to build from |
| `no plugins — provider has no e-invoicing config yet` | nothing in `account_configuration_plugins` for it |
| `already linked to this legal entity` | a plugin already holds this exact `legal_entity_id` |
| `all plugins already have a legal_entity_id (never overwritten)` | set, but to something else — the task never overwrites |
| `N unlinked plugins — ambiguous, pick one by hand` | more than one candidate; the unique index allows only one |

If two providers in one batch resolve to the **same** legal entity, that's a
unique-index collision: it's flagged with a `⚠`, and the task will apply one and
skip the rest. The verification pass below is what catches which one lost.

## Reset — undo the migration (⚠️ STAGING ONLY)

Clears the migration state for a provider so `legal_entities_migration:migrate`
starts from scratch. **Refuses production outright** — same stance as
`wipe_provider_einvoicing`. There is no undo.

```sh
./plugin_legal_entity_updates.js --reset 33
./plugin_legal_entity_updates.js --reset --print-only 33   # show the SQL, write nothing
./plugin_legal_entity_updates.js --reset --clear-einvoicing 33   # + wipe e-invoicing
./plugin_legal_entity_updates.js 33     # or pick Reset from the menu
```

### What it clears, and why in that order

Derived from a real run's audit trail (`billing_migration_statuses.metadata`
records every action the migration took), not guessed:

| # | Action | Table | Why |
|---|---|---|---|
| 1 | `SET NULL` | `accounting_documents.account_configuration_plugins` | unlink the plugin — a plugin still pointing at a deleted entity is the most confusing leftover |
| 2 | `DELETE` | `shedul.provider_purchases_primary_legal_entities` | the primary pointer, history rows included |
| 3 | `DELETE` | `shedul.location_legal_entity_assignments` | written by `AssignLocationsService` |
| 4 | `SET NULL` | `shedul.blast_marketing_transactions` | release back to the provider-wide bucket |
| 5 | `DELETE` | `shedul.billing_migration_statuses` | **last** — this is what lets the task re-run, so it must only go once nothing references the entity |
| 6 | `deleted_at = now()` | `legal_entities.legal_entities` | soft-delete the now-orphaned entities |

**Deliberately not touched:** `provider_purchases`, `provider_fees`,
`provider_purchase_payment_preferences`, `blast_marketing_campaigns`. They carry
`legal_entity_id`, but this migration never writes them and `provider_purchases`
are real financial records. The preview prints that list every run.

Legal entities are **soft**-deleted, not deleted: `legal_entity_associations`,
`_events`, `_capabilities` and `_field_versions` hang off those rows, and
`deleted_at` is the service's own convention (its schemas filter on
`where: [deleted_at: nil]`). `--keep-legal-entities` skips step 6; without it you
are asked.

### Also clearing the e-invoicing configuration (opt-in)

A reset leaves the provider's **e-invoicing** data untouched, because the
migration never created it. When that isn't a clean enough slate, reset offers to
wipe it too — **the default is no**, and `--clear-einvoicing` pre-answers the
prompt:

```
Also clear the provider's e-invoicing configuration?
  1) no — reset the migration state only            [default]
  2) yes — also wipe the provider's e-invoicing data
```

Answering yes deletes, children-first in one statement in
`accounting_documents`: `einvoicing_accounting_document_line_items`,
`accounting_document_error_logs`, `accounting_documents_logs`,
`e_invoice_compliance_records`, `e_invoice_trackers`, `accounting_documents`,
`einvoice_integration_issues`,
`einvoice_integration_application_requests`, `e_invoicing_configuration_logs`,
`account_configuration_addresses`,
`e_invoice_it_smart_receipts_configuration`, `account_configuration_plugins`,
and finally `account_configurations`.

This is the **same SQL** as `wipe_provider_einvoicing` — a single
data-modifying-CTE statement, so every FK check fires at statement end and the
CTE order can't cause a violation. The two copies are kept in step by hand;
scripts here stay self-contained. Still **not** touched: the `invoicing/` domain
(`invoice_parties` / `invoices` / `invoicing_periods`) and anything keyed only by
`invoice_entity_id`.

Note the blast radius is wider than the table above — `account_configurations`
and every accounting document go with it, and there is no undo. Reach for it when
you want the provider genuinely back to pre-onboarding, not just pre-migration.

### Gates

- **Production refused** before anything runs.
- Explicit provider list only — `--all` is rejected outright, and reset never
  offers an "all providers" prompt.
- **Per provider**, not in bulk: each gets its own row-count preview, then you
  type its `provider_id` back, then `yes`. A mismatch skips that provider.
- One transaction per database (`BEGIN`/`COMMIT` + `ON_ERROR_STOP`), so a failure
  rolls that database's changes back. The three databases are necessarily
  separate transactions.
- The e-invoicing wipe, if you asked for it, is inside that **same** per-provider
  confirmation — its rows are in the preview and its SQL in the echo before you
  type anything — and it runs **last**, after the plugin unlink whose rows it
  would otherwise delete out from under.
- Read-back afterwards: every target count must be zero, else `RESET: FAIL` and
  exit 1.

### Resetting may not be the fix

A reset only helps if re-running the migration produces something better. It
won't if the migrator itself is dropping fields — see the note on SA organization
entities under [Required fields](#required-fields-per-e-invoicing-country). Run
pre-flight after re-migrating to confirm you actually gained something.

## Report — scout everything before rolling out

```sh
./plugin_legal_entity_updates.js --report          # every provider, every country
./plugin_legal_entity_updates.js --report 33,52    # or a named handful
./plugin_legal_entity_updates.js --report -C IT    # Italy, and nothing but Italy
./plugin_legal_entity_updates.js --report --full   # with the caveats and footnotes
```

`--report` (alias `--scout`) is **stage 0**: the survey you take before the guided
rollout. One pass over **every** provider in `account_configurations` — no country
filter — answering *what have we got* rather than *does this one provider pass*.
Read-only.

**It is not pass/fail.** "289 providers aren't ready" is its expected finding, not
an error, so the verdict is `REPORTED` and the exit code is always `0`. Use
`--preflight` when you want a gate.

### Two axes: what prints, and what explains it

These are separate, and conflating them was a real defect — `detail` was the only
axis, so the only way to shorten the report was to throw away its data.

| Axis | Flag | Default in report | Controls |
|---|---|---|---|
| **tables** | `--detail` / `--summary` | on | the five-column per-provider field tables |
| **prose** | `--full` / `--concise` | **off** | banners, caveats, footnotes, per-country required-field lines, the `Reading …` progress lines, the read-only footer |

So `--full --summary` is a legitimate pair: every caveat, no tables. Both are asked
interactively (`How much report?` comes before the survey, because concise also means
no progress narration and by the first query it is too late to choose) and both can be
flipped from the refine menu mid-session without re-querying.

Concise is the default because the report is read far more often than it is read
*closely*. What survives it: the scope line, the filter notes, the tables, the roster,
the KYC block, the per-country readiness counts, and every genuine warning — a country
code that matched nothing, a provider that would fail the KYC gate. What goes: anything
that explains a finding rather than being one.

Implemented through the module-level `reportView` object rather than threading two
booleans through five printers. `printKycStatus` takes an explicit `prose` parameter
instead, because pre-flight calls it too and has no concise mode — reading `reportView`
there would have silently stripped pre-flight's explainer.

### One country means one country

A report whose shown set is a **single** country prints nothing about any other, and
`--full` does **not** override this. Suppressed: the Fresha B2B exclusion banner, the
`Country filter: IT — 6 of 8 excluded by it` count, the cross-country breakdown, the
`ALL` roll-up (the one country block already *is* the total), and the `## By country` /
`## Not covered` sections in the export. `scope.in_scope` and `scope.by_country` in the
JSON narrow to what was reported; `scope.surveyed` keeps the namespace-wide count.

```
Target: namespace=eng-orion psql_env=eng-orion  ·  Italy (IT)  ·  2 provider(s)

── Italy (IT) — 2 provider(s) ─────────────────────────
  ⛔ provider=102  not migrated  1 required field(s) not usable in billing info…
  ✓ provider=101  not migrated  billing info complete — ready to migrate
```

The country filter is still **display-only** (see the comment above `inScope`): the
reads always cover every country, so the refine loop can widen again without issuing a
single new query. Only the *description* of scope moved — it used to print before the
country question was even asked, which is why a filtered report used to open by
counting the countries you had just excluded.

`printB2bBanner` is called from inside `render()` for the same reason. It still comes
before the data it qualifies; it just now knows what that data is.

### Two shapes, because most providers have no legal entity yet

This is the thing that makes the report different from pre-flight. Before the
rollout most providers have not been migrated, so there is no legal entity on the
right-hand side of the comparison:

| Provider | What it gets | Question answered |
|---|---|---|
| **migrated** (has an active primary) | the ordinary field-by-field comparison, same as pre-flight | is the entity consistent with billing info, and is it linked? |
| **not migrated** | a billing-side **readiness** table — the same fields read from `provider_billing_informations` alone | will `migrate` have what it needs, or will it produce a blocked entity? |

```
── provider=52 (SA) — NOT MIGRATED ──────────────────
  e-invoicing country SA — no legal entity yet, reporting on billing info alone
FIELD             REQ?  PROVIDER BILLING (shedul)  READY?
registration no.  yes   12345                      ⛔ INVALID FORMAT
building number   yes   ∅                          ⛔ ABSENT — migrate has nothing to copy
district          yes   ∅                          ⛔ ABSENT — migrate has nothing to copy

  ⛔ 3 required field(s) not usable: building number (absent), district (absent),
     registration no. (invalid format)
     registration no.: "12345" — expected exactly 10 characters (valid_ksa_crn?)
```

Format rules are applied to the **billing** value here, not the entity's: `migrate`
copies it forward, so a malformed value arrives malformed.

### Sole traders: `account_type` replaces the guess

The un-migrated path used to infer the entity type. It no longer has to:
`provider_billing_informations.account_type` is read (it is in `PBI_COLUMNS`) and names the
shape `migrate` will build. It is a **binary** Rails enum —
`enum :account_type, %i[business individual]` — **not** the six-way account-type dropdown,
which writes `legal_entities.business_type` directly through the self-serve flow.
`BillingOnlyMigration::BUSINESS_TYPE_MAP` converts it:

| `account_type` | `business_type` | root | child |
|---|---|---|---|
| `0` `business` | `BUSINESS_TYPE_ORGANIZATION` | `organization` | none |
| `1` `individual` | `BUSINESS_TYPE_SOLE_PROPRIETORSHIP` | `individual` | `sole_proprietorship` |

`ACCOUNT_TYPE_SHAPE` mirrors that. The map's other six keys are unreachable until shedul's
enum widens, so those are the only two shapes `migrate` can produce today.

So a provider with no `company_name` but a populated `first_name` + `last_name` and
`account_type = individual` is now reported **`✅ via the person's name (LegalName
fallback)`** — a fact, not a question, because `LegalName` really does fall back to the
person's name for a sole proprietorship.

`entity_type_unclear` survives only for the case it is actually true of: `account_type` is
absent, so the shape genuinely cannot be known. It stays in `ATTENTION_STATES`.

**Why this mattered.** The first production run counted 64 blocked; 60 of those were ES
sole traders in exactly this shape. Conflating them with genuinely missing fields overstated
the problem by 60 providers, which is why the distinction is load-bearing and must not
regress even as the population approaches zero.

### Payments and KYC are reported for every provider the gate applies to

`providers.fresha_pay` is keyed on `provider_id` and needs **no** legal entity, so
payments status is knowable for every provider in the report. The KYC link
(`legal_entities.adyen_platform_legal_entity_id`) lives on the entity and is not.

**Except where there is no KYC at all.** `NO_KYC_COUNTRIES` in the script lists the
markets where Fresha Pay does not run on adyen-platform, so the gate is *inapplicable*
rather than unmet — SA today. In the report those providers are filtered out in
`kycRowsFor`: both the screen printers and the Markdown builder already skip an empty row
list, so one filter removes the section from both. A report narrowed to SA therefore prints
nothing about KYC anywhere. Verified in production 2026-08-12: SA holds no `legal_entities`
rows at all, and AE (7,244 entities) and ZA (16,552) have zero
`adyen_platform_legal_entity_id` between them. Reporting it anyway produced 279 rows of
which 257 were the identical `pending_migrate` sentence.

**Pre-flight applies the same exemption**, and applies it *earlier*. The report filters at
render time because its refine loop can widen the country filter again without re-querying;
pre-flight has no such loop, so `kycGateApplies` picks the provider set **before** the three
reads and a provider the gate cannot apply to never has its `fresha_pay` row queried at all.
A pre-flight over KSA issues none of those reads. Where it would otherwise print an empty
section it prints one line instead —

```
KYC / payments gate: not applicable — no Adyen KYC in KSA (SA), so there is nothing to gate on.
```

— which is the one place pre-flight and the report deliberately differ. The report is a
survey, where an absent section reads as "not surveyed"; pre-flight ends in PASS/FAIL over
providers you named, where silence about the gate would read as "the gate passed". Mixed
country sets keep the table and gain the same `Excludes …` qualifier the report carries,
naming how many of the compared providers it covered.

Where other countries remain in the same report the gate still prints, and carries a
qualifier naming what it excluded and how many providers it covers — a count that quietly
described a subset would read as the whole report. That line is **not** `--full`-gated: it
qualifies a number, so it is data, not prose.

So the gate splits:

| Situation | Gate |
|---|---|
| payments not enabled | `allowed` — KYC irrelevant (exact) |
| payments enabled, **no legal entity yet** | `pending_migrate` — undecidable, not failed (exact) |
| payments enabled, entity exists, not synced | `not_approved` (exact) |
| payments enabled, synced, adyen verification `success` | `likely_approved` (**not** exact) |
| payments enabled, synced, no verification row | `unknown` — the adyen-platform RPC is authoritative |

`pending_migrate` exists because the first version gated the whole block on
`migrated`, so a pre-rollout run — the entire point of this mode — printed no
payments or KYC information at all, having already queried it. `--summary` gets the
rollup; the default and the Markdown export get the full per-provider table. The
paragraph explaining where the two columns come from is prose, so `--full` only.

### building number and district — where migrate actually puts them

This used to be an "unverified propagation" hedge. It is now known, and the answer is
country-conditional. `PROPAGATION_TARGET` in the script records it:

| country | `building_number` → | `district` → |
|---|---|---|
| **SA** | `*.registeredAddress.buildingNumber` | `*.registeredAddress.district` |
| everywhere else | `*.registeredAddress.street2` | **dropped entirely** |

For SA, `KsaFieldMapper.localize/1` swaps the generic map for one with dedicated keys
("Shedul carries the Saudi national address as dedicated values … street2 is not sent").
Everywhere else `BillingOnlyMigration`'s generic map routes `building_number` into `street2`
and has no target for `district` at all. Since only `zatca` requires either, the generic
behaviour costs nothing — and the readiness table says `⚠ in billing — migrate drops it`
rather than pretending the value will arrive.

Two caveats worth keeping in view:

* Only `BillingOnlyMigration` and `CheckoutFreshaPayProviderMigrator` consult these maps.
  `AdyenFreshaPayProviderMigrator` builds the entity from app-adyen-platform KYC data and
  never reads billing info, so nothing here predicts its output.
* `ticket_bai` and `smart_receipts` **require** `building_number` while `default.ex` declares
  no key for it. That is not a propagation problem — it is unsatisfiable, and reported as
  such.

### States, worst first

The roster is sorted by these and so is the Markdown:

| State | Mark | Meaning |
|---|---|---|
| `no_billing` | ⛔ | **not migrated** and no active `provider_billing_informations` row — `migrate` has nothing to build from |
| `blocked` | ⛔ | migrated: required fields empty on the entity. Not migrated: required fields absent or malformed in billing info |
| `unsatisfiable` | ⛔ | a required field has **no slot or no declared key** for this shape and country. Equally fatal, but a **platform** gap — no data entry fixes it, so it is never pooled with `blocked` |
| `differ` | ✗ | migrated, and fields disagree with billing info |
| `entity_type_unclear` | ? | not migrated, `account_type` is absent, so the shape `migrate` will build cannot be known |
| `no_country` | ⚠ | no country on the account configuration — nothing can be assessed |
| `not_linked` | · | migrated and complete, but plugins aren't pointing at the primary — work for `link`, not a data problem |
| `ready` | ✓ | not migrated, billing info complete for its integration's rules — `migrate` should produce a good entity |
| `no_rules` | – | not migrated, billing row present, but the country has no e-invoicing integration |
| `done` | ✓ | migrated, complete, every plugin linked to the primary |

`ATTENTION_STATES` is everything except `ready`, `no_rules` and `done` — those are the
report working as intended, and only the others reach the "Needs attention" table in the
export.

**`no_billing` applies only to un-migrated providers.** A *migrated* provider with no
billing row is not a failure: the legal entity has already been judged against its
integration's required set, and an entity created through the self-serve flow never had a
billing row and never will. All that is lost is the cross-check, so it falls through to the
link state with `; no billing row to cross-check against` appended, and its
`comparison.status` in JSON is `no_billing_to_compare` rather than `differs`. Treating it as
⛔ marked every self-serve provider broken.

### Why `no_rules` and `no_country` exist as separate states

Only **SA, ES and IT** have an e-invoicing integration (`EINVOICING_INTEGRATIONS`).
The report still covers every other country, but a provider there cannot be scored
`ready`: nothing was required of it, so the word would mean something different from
the same word applied to a provider that actually cleared SA's eight fields. It gets
`no_rules` instead, and its readiness table says so rather than claiming a clean
sweep:

```
  – no required fields for GB — nothing here can fall short.
```

`no_country` is a different answer again, and a **warning** rather than a shrug:
`BillingDetailsPolicy` dispatches on the account configuration's country, so with no
country there is no way to know what *would* be required. "Nothing is required" and
"we cannot tell what is required" must not collapse into one number.

### The only thing not covered: the Fresha B2B account

`account_configurations` rows with `provider_id IS NULL` are the **Fresha B2B
account** — the configuration that releases Fresha's own B2B invoices. It is not a
provider, so it has no `provider_id`, and *every* query in this script keys on
`provider_id`. It cannot be folded in without a different lookup entirely.

That gets a **banner**, printed before any of the data it qualifies, and repeated as
one line at the tail where the totals are:

```
── EXCLUDED FROM THIS REPORT: the Fresha B2B account ───
  1 account_configurations row(s) have provider_id = NULL.
  That is the Fresha B2B account — the one that releases B2B invoices — not a
  provider. Every query here keys on provider_id, so nothing below covers it.
  It may need a legal entity of its own. NOT CONFIRMED — check separately.
```

**Open question (as of 2026-07-29): whether the B2B account needs a legal entity of
its own.** Unconfirmed. The banner says so rather than implying the exclusion is
harmless — if it turns out to need one, this script cannot tell you about it and
nothing in the rollout covers it.

> Earlier revisions of this file and the comment on `fetchAllProviderIds` claimed
> these rows were "already-migrated configs linked only through `invoice_entity_id`".
> That was never verified against the schema — no query in this repo reads
> `invoice_entity_id` from `account_configurations`. Corrected to the above.

A provider holding more than one configuration collapses to one row, and the
e-invoicing country wins where they disagree; the count of such providers is printed.

**No status or soft-delete filter is applied** to `account_configurations` — not
here and not in `fetchAllProviderIds`, which pre-dates this mode. If that table
carries a `deleted_at` or status column, dead configurations are being counted by
both. Worth confirming against the schema before quoting production totals.

### Refine it iteratively

Every query runs **once**, before the first render. After that the filters only decide
what gets drawn, so the report loops: render → change something → render again, with no
re-reading and no restart.

```
Refine the report?
  1) Done                                              [default]
  2) Change which countries are shown
       now: SA, ES, IT
  3) Change which conditions are shown
       now: no_billing, blocked
  4) Clear both filters — show everything
  5) Hide the per-provider tables
       the five-column field table for each provider
  6) Show the caveats and footnotes
       what each state means, the propagation caveat, the B2B exclusion
  7) Write the Markdown export now
       the filtered set, as it currently stands
```

Options 5 and 6 are the two axes from above, and both re-render from data already in
memory — expanding a concise report costs nothing.

This is why the country choice is a **display** filter rather than a narrowing of the
reads: widening it mid-session would otherwise need rows that were never fetched. The
cost is that `-C SA` reads every country's providers anyway — the same volume as an
unfiltered run, which is the default — and the provider list remains the lever that
actually narrows the SQL. The test suite asserts no query is issued after the first
render.

The export can be written as many times as you like from option 6; if you never take
it, it's offered once on the way out. Both filters are recorded in the export each time,
so a file written from a narrowed view says so.

A non-interactive run (`--yes`, or no terminal) renders once with whatever the flags
said and exits — no menu.

### Four questions, asked or flagged

Run it bare and it asks all four, in the order the answers can be shown back with real
counts. Every prompt is skipped when the matching flag already answered it, or when
there's no terminal.

| Question | Asked | Flag |
|---|---|---|
| **providers** | before any query, so a list narrows the very first one | positional IDs, or `-f/--file` |
| **how much report** | before the survey — concise also means no progress lines | `--full` / `--concise` |
| **countries** | after the survey, so options carry counts | `-C` / `--countries` / `--country` |
| **conditions** | after classification, so options carry states and counts | `--states` |

**Providers** — all, a list you type, or a list from a file.

**How much report** — concise by default; see [Two axes](#two-axes-what-prints-and-what-explains-it).

```
How much report?
  1) Concise — the numbers and the tables, nothing that explains them   [default]
       no exclusion banner, no footnotes, no progress lines
  2) Full — every caveat, footnote and exclusion banner
```

**Countries** — the options are built from the data, so you never guess a code:

```
Which countries?
  1) all 6 countries                                        [default]
       SA 4 ES 2 IT 1 GB 1 (no country) 1 US 1
  2) only the e-invoicing countries — SA, ES, IT
       the only countries with a required-field set, so the only ones that can be blocked by one
  3) only countries I name
  4) everything EXCEPT countries I name
```

Include *or* exclude — excluding is usually what you want when a couple of countries
are noise. Non-interactively:

```sh
./plugin_legal_entity_updates.js --report -C SA        # KSA only
./plugin_legal_entity_updates.js --report -C SA,ES     # KSA and Spain
./plugin_legal_entity_updates.js --report -C none      # configurations with no country
```

Codes are case-insensitive and `none` means "no country on the configuration". A code
that matches nothing is refused at the prompt and called out by the flag — a typo would
otherwise silently shrink the report. A country filter that matches **nothing at all**
exits `2` (a bad invocation, since the prompt validates) and lists the countries that
*are* present. A **condition** filter matching nothing exits `0` — "nothing is blocked"
is a real answer, not a mistake.

Narrowing to **one** country also strips everything that would name another — see
[One country means one country](#one-country-means-one-country). Two or more and the
cross-country roll-up comes back, because then the totals genuinely need it.

**Conditions** — the states that actually turned up, with counts:

```
Which conditions?
  1) every provider (8)                                     [default]
       no_billing 1 blocked 2 entity_type_unclear 1 no_country 1 not_linked 1 ready 2
  2) only those needing attention (6)
  3) only hard blockers — missing required data (3)
  4) states I name
```

Or `--states blocked,no_billing`. Unknown states are rejected with the list of known
ones.

Whatever a filter removes is named, because the rollup counts only what's shown:

```
Country filter: SA, ES, IT, (no country)  — 2 of 10 provider(s) excluded by it
Condition filter: no_billing, blocked  — showing 3 of 8 provider(s)
  hidden by it: ready 2   entity_type_unclear 1   no_country 1   not_linked 1
```

The country breakdown in the rollup is derived from the rows being reported, not from
the pre-filter scope, so it can never disagree with the per-country blocks under it.
The Markdown export leads with a **This report is filtered** callout naming all three —
a reader who wasn't at the terminal cannot otherwise tell a full sweep from a slice.

### Separated by country

**SA, ES and IT are reported on their own**, each with the required set that applies
to it, because they run different validators and in practice fail differently — the
first production run was 60 ES sole traders and 4 malformed KSA tax numbers, which
pooled together said nothing useful. Grouping applies to the per-provider tables, the
roster, the rollup and the Markdown sections:

```
══ KSA (SA) — 271 provider(s) ═══════════════════════════
  requires: state province, city, postal code, address, tax number,
            company registration number, building number, district
```

Order is the declaration order of `EINVOICING_REQUIRED` (SA, ES, IT), then any other
country alphabetically, then the no-country group. The rollup prints a per-country
block and then a single `ALL` line; the export leads with a **By country** table.
`COUNTRY_NAMES` maps the three codes to names — anything else shows as its bare code.

The KYC / payments gate stays a single cross-country table: it keys on the provider,
not the validator, so splitting it would add sections without adding information.

### Where the tables go

**Every provider gets the full five-column field table, by default** — `FIELD`,
`REQ?`, `PROVIDER BILLING`, `LEGAL ENTITY (fields jsonb)`, and the verdict. `--summary`
drops them for a rollup only; they are in the Markdown export either way. The export
prompt defaults to **yes** here (pre-flight's defaults to no).

The shape is deliberately identical whether or not an entity exists. For an
un-migrated provider the legal-entity column names the key `migrate` has to land the
value in and shows `∅` — the same rendering the comparison uses for a field the entity
is missing:

```
building number   yes   9876   organization.registeredAddress.buildingNumber = ∅   ⚠ in billing — propagation unverified
```

Keys that vary by entity type are shown in their `organization` form, since the type
isn't decided until `migrate` runs. The table footnote says so.

### Plugin status is reported, and decides nothing

The export carries a `— plugin status` section per country, between the ready table and the
per-provider blocks, plus the same table inside each provider's block. Columns:
`plugin_status` (ours) and `third_party_integration_status` (the integrator's — comarch,
invopop), alongside type, integrator, integration and the linked entity. Both come off
`account_configuration_plugins`, which `fetchPlugins` was already reading.

Both statuses also appear as columns in the **needs attention** and **ready** tables, before
the note — the note is the widest cell, so anything after it stops being scannable. That is
where they matter most: a provider with complete billing info reads `ready` even when its
plugin is `failed`, and 20 of the first SA run's 279 were in that shape. A provider holding
several plugins gets their states joined (`disabled · paused`) rather than reduced to a worst
case, since picking one would hide the other; `—` means no plugin row exists at all, which is
not the same as a plugin whose status is empty (`∅`).

**Neither feeds the State column.** `classifyProvider` does not look at them, on purpose:
they say whether e-invoicing works *today*, while the report's states say whether `migrate`
can build a usable legal entity. A provider can be `ready` with a `failed` plugin, and the
first production SA run had 20 of 279 in exactly that shape while every one of them read
`ready`. Folding plugin health into the state would have moved the headline counts and made
two runs incomparable; marking it leaves the numbers alone.

One row per **plugin row**, not per provider — the same reason the plugin audit does it that
way. Anything other than `enabled` is marked `⚠ **state**`; a provider holding no plugin at
all is counted in a trailing line rather than given an empty row, because "no plugin yet" and
"plugin in a bad state" are different problems. The tally line above the table is computed
from the plugins on show, so a filtered report never quotes a namespace-wide number. The
paragraph explaining the two columns is prose, so `--full` only.

Default filename: `rollout-report-<namespace>-<YYYY-MM-DD>.md`.

## Plugin audit — billing info vs each plugin's legal entity

```sh
./plugin_legal_entity_updates.js --plugins            # every provider with a plugin
./plugin_legal_entity_updates.js 33     # or name a set up front
```

**Why this isn't pre-flight.** Pre-flight compares billing info against the
provider's **primary** legal entity. This compares it against the legal entity each
**plugin** actually points at — which is what the send path reads:
`BillingDetailsPolicy` resolves the plugin, then uses `plugin.legal_entity_id`. The
two answers differ exactly when a plugin has drifted off the primary, and it's the
plugin's copy that decides whether an invoice can be issued.

One section per **plugin row**, not per provider: a provider can hold several
plugins and each carries its own `legal_entity_id`.

```
   PROVIDER  PLUGIN  TYPE        STATUS   PLUGIN'S LEGAL ENTITY  RESULT
✓  18        1       einvoicing  pending  019fa326-f225…         7/7 agree
✗  33        8       einvoicing  enabled  019fa8cf-8408…         8/10 agree  ⛔ 2 unusable
✗  52        15      einvoicing  enabled  019f895b-0db5…         0/8 agree   ⛔ 5 unusable
–  99        7       einvoicing  pending  ∅ not linked           nothing to compare — run link first
```

Providers are discovered from `account_configuration_plugins` (joined to
`account_configurations` for `provider_id`), not from `account_configurations` — a
provider can have a configuration with no plugin, and that has nothing to audit.

Unlinked plugins are reported `–` and skipped: there's no entity to compare
against yet. Plugins pointing somewhere other than their provider's primary get a
`⚠ not the primary` marker and a dedicated section showing both UUIDs — not wrong
by itself, but it means pre-flight and this mode are looking at different entities.

Reuses the same required-field sets, KSA format rules and Markdown export as
pre-flight. Detail is automatic: five providers or fewer gets the full tables.

**On the counts:** a field empty on *both* sides is technically "equal" but still
blocking, so it does not count toward `n/m agree` — agreement on nothing is not
agreement. That's why providers whose legal entity carries no address at all read
`0/8 agree`.

## Migrate — create the legal entities

The first step of the workflow, and the one everything else depends on: without a
legal entity and a primary pointer there is nothing to compare or link.

```sh
./plugin_legal_entity_updates.js --migrate 12345,67890
./plugin_legal_entity_updates.js            # or pick Migrate from the menu
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

**Explicit provider list only.** `--all` is rejected outright, migrate offers no
"all providers" prompt,
and `COUNTRY_CODES` / `PROVIDER_IDS_CSV_URL` are deliberately not exposed even
though the task supports them — "every provider with an account configuration" is
the wrong set for a migration, and a stray Enter must not migrate everything.

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
   `--no-payment-methods` turns it off; without it you are asked.

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

Pick it at the first prompt. Answers
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
decision. Plain `not linked` rows are just pending work: re-run in link mode
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
inspecting them, so you get the checklists; choosing "all providers" is a bulk
sweep, so you get one line each. `--detail` and `--summary` force either way.

### The field mapping, verified end to end

Traced against the checked-out repos on 2026-07-29, not inferred. The comparison never
sees the RPC — it reads the `fields` jsonb directly — so the mapping it encodes has to
match what the RPC would project out of those same rows.

```
legal_entities.fields (jsonb)
  → LegalEntities.InvoicePartyDetailsMapper.extract/1        (app-legal-entities)
      LegalName.extract/2  · Address.extract/2  · Identifiers.extract/2
  → InvoicePartyDetails{legal_name, address, identifiers}
  → LegalEntityBillingDetails.map_billing_details/1          (app-accounting-documents)
  → the billing map @required_fields validates
```

For an `organization` root with no child:

| billing field | ← `InvoicePartyDetails` | ← `fields` key |
|---|---|---|
| `company_name` | `legal_name` | `organization.legalName` |
| `tax_number` | `identifiers[TAX_NUMBER]` | `organization.vatNumber` |
| `company_registration_number` | `identifiers[COMPANY_REGISTRATION_NUMBER]` | `organization.registrationNumber` |
| `address` | `address.street` | `organization.registeredAddress.street` |
| `building_number` | `address.building_number` | `organization.registeredAddress.buildingNumber` |
| `district` | `address.district` | `organization.registeredAddress.district` |
| `state_province` | `address.region` | `organization.registeredAddress.stateOrProvince` |
| `city` | `address.city` | `organization.registeredAddress.city` |
| `postal_code` | `address.postal_code` | `organization.registeredAddress.postalCode` |
| `country_code` | `address.country_code` | the `legal_entities.country_code` **column** |

Note `state_province` ← `address.region` ← `stateOrProvince`: three names for one value.

### A legal entity is TWO rows, and `business_type` decides which one answers

The root carries `business_type` (8 values); its child, where it has one, carries `type`
and a NULL `business_type`. A check constraint
(`legal_entities_business_type_required_for_root`) keeps them complementary:

```
root  → type IN (individual, organization)                                AND business_type IS NOT NULL
child → type IN (sole_proprietorship, trust, unincorporated_partnership)  AND business_type IS NULL
```

They are joined through `legal_entity_associations` — there is **no `parent_id`** — and a
root has at most one child. Every active primary pointer targets a root.

`ENTITY_SHAPES` in the script is the whole mapping, transcribed from
`fields_configuration/business_types.ex` `entity_type_for/2` plus the two dispatch tables.
Eight business types, five distinct `(root, child)` pairs:

| `business_type` | root | child | address prefix | identifiers | legal name |
|---|---|---|---|---|---|
| `organization` | `organization` | — | `organization.registeredAddress.*` (root) | `organization.*` | `organization.legalName` |
| `partnership_incorporated` | `organization` | — | same | same | same |
| `association_incorporated` | `organization` | — | same | same | same |
| `non_profit` | `organization` | — | same | same | same |
| `organization_trust` | `organization` | `trust` | `organization.registeredAddress.*` (root) | `organization.*` (root) | `trust.name` (child) |
| `sole_proprietorship` | `individual` | `sole_proprietorship` | `soleProprietorship.registeredAddress.*` (**child**) | `soleProprietorship.*` (**child**) | `soleProprietorship.name`, else the person's name |
| `unincorporated_partnership` | `individual` | `unincorporated_partnership` | `unincorporatedPartnership.registeredAddress.*` (**child**) | `unincorporatedPartnership.*` (**child**) | `unincorporatedPartnership.name` |
| `individual_trust` | `individual` | `trust` | `individual.residentialAddress.*` (root) | **none — `[]`** | `trust.name` (child) |

Two traps this table exists to avoid:

* **A sole trader keeps its address AND identifiers on the child.** Its root holds only
  `individual.name.*`. This is the majority shape — ~75% of primary pointers, and 12 of 15
  in the e-invoicing countries.
* **`individual.residentialAddress.*` belongs to `individual_trust` only**, never to a sole
  trader. `FIELD_COMPARISON` used to imply otherwise.

`LegalName` for a sole prop takes `soleProprietorship.name`, falling back to
`individual.name.firstName + " " + lastName` — so a sole trader's `company_name` is
satisfied by the person's name when there is no trading name. SA and AE never declare
`soleProprietorship.name` at all, so theirs always invoice as the individual. The script
models that fallback as the synthetic key `LEGAL_NAME_FROM_PERSON`.

`FIELD_COMPARISON` therefore no longer holds static key lists. Each spec names a **slot**
(`address` / `identifier` / `legalName` / `individualName` / `column`) and `leKeysFor(shape,
spec)` derives the real key. An empty result means the shape has no slot for that field —
a fact about the entity type, not a missing value.

**`fetchLegalEntityFields` loads the child.** Its SQL unions the child's `fields` in under
the **root's** id, so every existing caller is unchanged, plus pseudo-keys
`_column.business_type`, `_column.child_type`, `_column.child_id`. The child arm comes
**last on purpose**: on a key collision the child wins, because a pre-hierarchy `individual`
root can carry a legacy `soleProprietorship.vatNumber` (`default.ex`
`individual_legacy_fields`) and the mapper reads the child's value. Rows with a NULL
`business_type` fall back to the old binary guess via `shapeFor/2` and are labelled as
inferred.

`tax_number` probes **only** `*.vatNumber`. `*.taxInformation.number` is emitted as
`IDENTIFIER_KIND_TAX_IDENTIFICATION_NUMBER`, a different kind that
`LegalEntityBillingDetails` does not read for `tax_number` — probing it would report a
tax number the RPC would leave `nil`, masking the failure app-accounting-documents
deliberately makes loud ("a TIN-slot country would fail validation loudly rather than
silently emit its TIN as a VAT").

### Required fields per e-invoicing country

Pre-flight knows what app-accounting-documents will actually demand, so it can
tell a cosmetic difference from something that **blocks e-invoicing**. Both
validators fetch the legal entity via `GetLegalEntityInvoiceDetails` and hard-fail
with `{:error, :missing_required_fields}`:

> **Corrected 2026-07-31.** This section used to describe "two validators", ES and IT
> sharing a `Common.LegalEntityBillingDetails`. **That module does not exist.** There are
> **four** per-integration validators, and the required set is keyed by **integration**, not
> country — ES has *two* integrations whose sets differ. The script's country-keyed
> `EINVOICING_REQUIRED` is wrong for ES and IT; see the defect table below.

Four validators, each owning its own mapper and required set, dispatched by
`Common.LegalEntityBillingResolver.for_integration/1` on the plugin's `integration` enum
(`account_configuration_plugins.integration`; `Enums.e_invoice_integration` =
`:zatca | :verifactu | :ticket_bai | :smart_receipts`) — **not** on country:

| integration | country | module | onboarding entry point |
|---|---|---|---|
| `:zatca` | SA | `Comarch.LegalEntityBillingDetails` | `Comarch.Actions.OnboardProviderToKsaAction` |
| `:verifactu` | ES | `Invopop.ES.Verifactu.LegalEntityBillingDetails` | Invopop register |
| `:ticket_bai` | ES | `Invopop.ES.TicketBai.LegalEntityBillingDetails` | Invopop register |
| `:smart_receipts` | IT | `Invopop.IT.SmartReceipts.LegalEntityBillingDetails` | Invopop register |

Required fields per integration — onboarding vs send, since only `zatca` and
`smart_receipts` differ between the two (`verifactu` and `ticket_bai` both have
`fetch_billing_informations/2` delegate straight to `fetch/1`):

| Field | `zatca` | `verifactu` | `ticket_bai` | `smart_receipts` |
|---|---|---|---|---|
| `company_name` | send only (onboarding takes it from the request) | **required** | **required** | **required** (both paths) |
| `tax_number` | **required** | **required** | **required** | **required** (both paths) |
| `address` (street), `city`, `postal_code` | **required** | **required** | **required** | onboarding only |
| `state_province` | **required** | — *(not required)* | **required** (derives the foral region `VI`/`BI`/`SS`) | onboarding only |
| `building_number` | **required** | — | **required** | onboarding only |
| `district` | **required** | — | — | — |
| `company_registration_number` | **required** | — | — | — |
| `country_code` | not checked | not checked | not checked | not checked |

All four read `identifiers[TAX_NUMBER]` for `tax_number` and hard-fail with
`{:error, :missing_required_fields}`.

The constant is now `EINVOICING_INTEGRATIONS`, keyed by integration and carrying
`{country, module, onboarding, send}`; `send: null` means `fetch_billing_informations/2`
delegates to `fetch/1`. `requiredFieldsForIntegration/1` returns the union of both paths,
and `requiredPathNote/1` annotates which path demands the extras. The old country-keyed
`requiredFieldsFor(country)` survives only for grouping and the "is this an e-invoicing
country" checks; it resolves through `DEFAULT_INTEGRATION` and must not be used to judge an
individual provider.

**Three defects this fixed.** The old country-keyed set was:

| | script said | reality | effect |
|---|---|---|---|
| `SA` | the 9 fields | exactly `zatca`'s onboarding ∪ send | was correct |
| `ES` | included `state_province` | `verifactu` does not require it, and **no ES entity carries `stateOrProvince`** | false block on every ES provider |
| `ES` | omitted `building_number` | `ticket_bai` requires it | missed block |
| `IT` | omitted `building_number` | `smart_receipts` onboarding requires it | missed block |

**And a platform gap:** `ticket_bai` and `smart_receipts` both require `building_number`, but
their field config is `Default`, whose address keys are
`street, street2, city, postalCode, stateOrProvince, country` — there is **no `buildingNumber`
key to store a value in** (only `sa.ex` defines one). So onboarding an ES TicketBAI or IT
SmartReceipts provider *from a legal entity* cannot succeed for any business type. Confirmed
live in eng-pierogi: 0 of 9 ES and 0 of 11 IT entities carry `buildingNumber`. IT **sending**
still works — it needs only `company_name` + `tax_number`.

That is reported as the `unsatisfiable` state, never as `blocked` — see
"Satisfiability" below.

### Satisfiability — a third outcome, and why it is not `blocked`

A required field has to clear **two** independent bars, and the second one is easy to miss:

1. **is there a slot** — does the invoice projection probe any key for it on this shape?
   `identifier_keys/2` returns `[]` for `(individual, trust)`, so an `individual_trust` can
   never carry a `tax_number`.
2. **is the key declared** — `create_legal_entities.ex` filters submitted fields against
   `Lookup.available_legal_entity_fields_for_validation(country, business_type, role)` at the
   persist boundary ("Filters submitted fields to the LE allowlist"). A write to an
   undeclared key is **silently dropped**, so undeclared means permanently empty.

Either failure is a **platform gap, not a merchant one** — no data entry can fix it. Pooling
it with genuinely-unfilled fields sends someone chasing a merchant who has nothing to give,
so it gets its own row mark, its own provider state, and its own count:

| mark | meaning | owner |
|---|---|---|
| `⛔ BLOCKS e-invoicing` | slot exists, key declared, **value empty** | merchant / `migrate` |
| `⛔ NO SLOT on this entity type` | the projection emits nothing here | platform |
| `⛔ UNSATISFIABLE — no key in config` | undeclared; dropped at persist | platform |

`DECLARED_KEYS` holds two sets — `SA` from `country/sa.ex`, and `DEFAULT` from `default.ex`
for every country with no module, **which includes ES and IT**. `declaredSourceFor(country)`
names which one answered, so the output says `default.ex (no country module)` rather than
implying a Spain-specific rule. The day a `country/es.ex` lands, these answers change and
that set has to be added. `UNSUPPORTED_CHILD` records that `sa.ex` implements neither
`unincorporated_partnership_child/0` nor `trust_child/0`, so `Country.get_for/2` returns `[]`
and the whole child namespace is undeclared for those pairs.

Coverage across 4 integrations × 8 business types: **11 of 32 complete**. The two universal
gaps are `ticket_bai` and `smart_receipts`, neither satisfiable by *any* business type.
`scratchpad/coverage.js`-style verification: the script's own tables reproduce that matrix
row for row.

`EINVOICING_REQUIRED.SA` is the union of `zatca`'s two paths: Comarch's `building_number` +
`district`, plus the send path's `company_name`. A provider that onboards and then cannot
send is not usable, so the script asks for both and labels the extra:

```
  note: company name is required by the SEND path
        (Comarch.LegalEntityBillingDetails @send_required_fields), not by this
        integration's onboarding validator
```

The one exception is the allow-listed legacy KSA per-location flow
(`@legacy_ksa_multi_plugin_provider_ids`, currently `[1_135_636]`), which uses location
billing and never touches a legal entity. `REQUIRED_BY_SEND_PATH_ONLY` in the script
records the annotation.

Earlier revisions of this table claimed KSA's `tax_number` was
`TAX_NUMBER` while ES/IT was `TAX_IDENTIFICATION_NUMBER`. All four actually read
`identifiers[TAX_NUMBER]`, which `Identifiers.keys_for/1` emits from `*.vatNumber`;
`TAX_IDENTIFICATION_NUMBER` comes from `*.taxInformation.number` and no validator
reads it. The ZATCA-vs-NIF distinction is about the *value*, not the slot.

The **integration** comes from `account_configuration_plugins.integration` — that is what
`LegalEntityBillingResolver` dispatches on. Country
(`account_configurations.country_code`) is what `BillingDetailsPolicy` uses to pick the
*send* path (`%{country_code: "SA"} = account_configuration`), and it is still the right
grouping key for the report's output — but it does **not** determine the required set, because
ES maps to two integrations. A provider with no plugin row yet has no integration to read, so
the un-migrated path has to assume one: use `verifactu` for ES (the live one) and **say so**,
because assuming `ticket_bai` would manufacture a `building_number` block for every ES
provider. Countries with no integration have no required set, and the comparison stays purely
informational for them.

A required field missing on the **legal-entity** side is reported as
`⛔ BLOCKS e-invoicing` and fails the run. That's stronger than "differs": the
onboarding/send path will refuse the provider outright.

### KSA format rules — presence isn't the only bar

`AccountingDocuments.Helpers.ValidationHelpers` also enforces *shape*, so a
present-but-malformed value fails just as hard:

| Field | Rule | Source |
|---|---|---|
| `company_registration_number` | exactly 10 characters | `valid_ksa_crn?` |
| `tax_number` | 15 digits, starts `3`, ends `03` — `~r/^3\d{12}03$/` | `valid_ksa_tax_id?` |

Checked against the **legal-entity** value, because that's what the onboarding path
reads. Reported as `⛔ INVALID FORMAT`, and the blocked roster distinguishes
`(missing)` from `(invalid format)` — different problems, different fixes.

`@necessary_onboarding_fields` in `onboard_provider_to_ksa_action.ex` is the same
eight-field set as Comarch's `@required_fields` (it lists `postal_code` twice —
harmless), so there's nothing extra to model there.

### Export it as Markdown

`--md [path]` writes the comparison to a file — and if you don't pass the flag,
pre-flight offers the export at the end anyway (default No):

```sh
./plugin_legal_entity_updates.js --preflight --all --md
./plugin_legal_entity_updates.js --preflight 33 --md /tmp/provider-33.md
```

Without a path it writes `preflight-<namespace>-<YYYY-MM-DD>.md` in the working
directory. The document leads with the **blocked roster** (the actionable part),
then a per-provider field table, then the required-field and format rules with
their source modules — so it stands on its own pasted into a ticket.

Built from the comparison data, never from the terminal output: that carries ANSI
escapes when stdout is a TTY, and its padding is meaningless in Markdown. Values
containing `|` are escaped. `--summary` drops the per-provider tables and keeps the
roster.

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
before linking. Providers with no billing row don't decide the verdict either
way: they have nothing to be inconsistent about. Providers with no primary legal
entity don't either, but they are reported in **red** — they were not compared
against anything, and a gap nobody looked at is easier to overlook than a
difference sitting in a table.

```
══ PRE-FLIGHT: FAIL ════════════════════════════════════
  ✗ 2 provider(s) where billing info and the legal entity disagree.
  ⚠ 3 provider(s) skipped — no billing row.  (Nothing to compare…)
  ⊘ 1 provider(s) NOT checked at all — no primary legal entity.
```

**Nothing comparable at all is a FAIL**, and it is the one thing that overrides
the rule above. If *not one* of the providers has an active primary legal entity,
the run stops there and exits `1`:

```
  ⊘ 2 providers were NOT checked — no active primary legal entity:
      provider=33 — billing details are present, so migrate has not run yet.
                    Fix: run migrate for provider 33, then re-run pre-flight.
      provider=41 — no active provider_billing_informations row either, so
                    migrate would have nothing to build an entity from.
                    Fix: get billing details onto the provider first.

══ PRE-FLIGHT: FAIL ════════════════════════════════════
  ⊘ Nothing was compared — not one of these 2 providers has an active
    primary legal entity.
    Going further is pointless: link has nothing to link and post-flight
    nothing to audit. Run migrate first.
```

The asymmetry is deliberate. "Some providers checked and consistent" is a real
pass; "nothing checked" is a pre-flight that never happened, and a green PASS
there would be approval of data nobody looked at — including to `runGuidedStep`,
which branches on the exit code, so the walkthrough now stops at pre-flight
instead of walking on into a `link` with nothing to link. A bulk `--all` sweep
legitimately contains plenty of un-migrated providers, so it must not go red for
that alone.

The two fix lines differ because the gaps do. `migrate` builds the legal entity
*from* `provider_billing_informations`, so pre-flight reads that table for every
provider — including the ones with no primary pointer — purely to separate
"waiting for migrate" from "migrate would have nothing to build from". The
`--json` `skipped[]` entries carry the same distinction as
`has_billing_details: true|false`.

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

On **production** the service is `accounting-documents-web` — the app is split
into web and worker components there and only the web one carries the plain name.
Every other namespace runs it undivided as `accounting-documents`. The script
picks the right one from the namespace; `-s` overrides it.

When the script runs it itself, it appends `--no-tui -w` so the task's logs
stream into your terminal; the full argv is echoed before the spawn.

## Arguments

Every flag is optional and only pre-answers a prompt. Run the script with none of
them and it asks you everything, in order.

```sh
./plugin_legal_entity_updates.js [FLAGS] [provider_ids]
#   Target
#     -n, --namespace NAME   namespace / env; drives the psql env AND the task's --namespace
#     -s, --service NAME     Houston service (default: accounting-documents)
#   Providers
#         --all              every provider in account_configurations
#     -f, --file PATH        read provider IDs from a file ("#" starts a comment)
#   Mode
#         --guided           the whole procedure, step by step
#         --migrate          create the legal entities (partners-app); explicit ids only
#         --preflight        READ-ONLY: billing info vs the PRIMARY legal entity
#         --postflight       READ-ONLY: is every plugin linked? (--verify is an alias)
#         --link             run link_plugins_to_legal_entities_from_env
#         --plugins          READ-ONLY: billing info vs each PLUGIN's legal entity
#         --report           READ-ONLY: scout every provider in account_configurations
#                            (--scout is an alias)
#         --reset            STAGING ONLY, destructive: undo the migration
#   Link
#         --apply            DRY_RUN="false" — actually write
#         --dry-run          DRY_RUN="true" — logs only (the default)
#         --print-only       print the command and stop; run nothing
#   Migrate
#         --no-payment-methods   MIGRATE_PAYMENT_METHODS=false
#         --copy-tax-number      COPY_TAX_NUMBER=true
#         --batch-size N         BATCH_SIZE=N
#   Reset
#         --keep-legal-entities  don't soft-delete the orphaned legal entities
#         --clear-einvoicing     ALSO wipe the provider's e-invoicing data
#                                (default: no — you're asked)
#   Reporting
#     -C, --countries LIST   report only these countries (SA / SA,ES / none). --report
#                            ONE country ⇒ nothing about any other is printed
#         --md [PATH]        export as Markdown (preflight-<ns>-<date>.md, or
#                            rollout-report-<ns>-<date>.md for --report)
#         --detail/--summary force the per-provider checklist on/off
#         --full/--concise   the prose axis: caveats, footnotes, banners, progress
#                            lines. --report only; concise is the default
#   Non-interactive
#         --json             result document on stdout, report on stderr
#         --yes              run without a terminal — READ-ONLY MODES ONLY
#     -h, --help             this help
```

IDs may be comma- or whitespace-separated, and are deduped. `--all` is rejected by
`--migrate` and `--reset`: "every provider with an account configuration" is the
wrong set for either, and a stray `--all` must not hit everything.

## Running this yourself (agents, CI)

`--yes` lifts the terminal requirement for the modes that **cannot write** —
`--preflight`, `--postflight`, `--plugins`, and `--link --dry-run`. Combined with
`--json` you get a parseable result instead of tables:

```sh
./plugin_legal_entity_updates.js --postflight --all --json --yes | jq .verdict
./plugin_legal_entity_updates.js --preflight 33 --json --yes | jq '.providers[0].blocking'
```

Everything that writes — `--link --apply`, `--migrate`, `--reset` — still refuses
without a TTY, **in every namespace**, and `--yes` is not accepted at a write
confirmation even if one is somehow reached. The boundary is "can this mode
write?", not "is this production?": a read-only mode is safe in prod, and a write
is not safe in staging merely because it is staging.

Two prompts have no non-interactive default and error out instead of guessing: the
mode (pass a mode flag) and the provider set (pass IDs, `--all`, or `--file`).
"Every provider" and "these three" are different requests.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | pass, or nothing to do |
| `1` | the **data** is wrong — drift, a mismatch, a row that didn't land, or a pre-flight that could compare **nothing at all** (no primary legal entity for any provider given) |
| `2` | the **call** is wrong — bad flag, or approval was impossible without a TTY |

`--json` repeats the code in `exit`, so a caller reading the document never has to
also inspect `$?`.

### Providers with more than one legal entity

`provider_purchases_primary_legal_entities` has a partial unique index on `provider_id
WHERE valid_to IS NULL`, so a provider has **at most one** active primary. A provider with
two legal entities therefore cannot be described by that pointer, and every mode that
reasons from it alone gets that provider wrong:

| Mode | What it did | Why it was wrong |
|---|---|---|
| link | skipped it — "2 unlinked plugins — ambiguous, pick one by hand" | there is no ambiguity; each plugin has its own entity |
| post-flight | one row, one expected value — the second plugin read as drift | the second plugin is *supposed* to hold a different entity |
| pre-flight | compared billing info against the primary | one billing row, two branches: 8 of 10 fields "differ" |

`MULTI_ENTITY_PROVIDERS` is the exemption: provider → plugin → legal entity, hand-verified,
never inferred. A provider absent from it keeps the refuse-to-guess behaviour, which is the
right default for an ambiguity nobody has looked at yet.

**Provider 1135636 (KSA)** is the first entry. Verified in production 2026-08-24 by joining
`accounting_documents.company_registration_number` per plugin to each entity's
`organization.registrationNumber` — the branch each plugin has actually been invoicing as,
which is the only evidence that distinguishes them:

| Plugin | Created | CRN in its documents | → entity |
|---|---|---|---|
| 12 | 2025-07-28 | 1010291884 until 2026-05-04, then 1010403997 (1,424 docs) | `01a03382-5190-…` "Supernova Salon Olaya" |
| 402 | 2026-05-05 | 1010880577 throughout (866 docs) | `01a03382-5166-…` "Supernova Salon Murooj" ← primary |

Both entities came out of the same migrate run (11:22:53) and share one VAT number,
`300474119700003`, with different registration numbers: two branches of one taxpayer, not a
duplicate to clean up. CRN 1010291884 is the pre-split number, has no legal entity, and
nothing links to it. To add a provider, run those two queries and record what they say.

Consequences to keep in mind:

- **The audit is one row per provider except here**, where it is one per plugin — a single
  row cannot carry two expected values. `auditProviders` therefore `flatMap`s, and every
  count a human reads (`auditProviderCount`) is over **distinct providers**, so one
  provider is never counted twice. A provider with one correct plugin and one drifting one
  appears in both counts, which is the truth about it.
- **Link resolves per plugin** and annotates each line, because an entity that is not the
  provider's primary otherwise reads as the pointer having resolved wrongly.
- **Pre-flight still compares the primary only** — `compareFields` takes one entity — but
  now says which entity it left out and points at `--plugins`. For 1135636 that means it
  FAILs by construction: the billing row describes Olaya (reg 1010403997) and the primary
  is Murooj (reg 1010880577), so 8 fields "differ" without anything being wrong. Read the
  `--plugins` audit for that provider instead.

### The JSON document

One object on stdout per run. Common envelope: `schema_version`, `mode`,
`namespace`, `service`, `exit`, `verdict` (`PASS` / `FAIL` / `ABORTED` / `PRINTED`
/ `REPORTED` / `ERROR`), plus `tally` and a per-subject array — `providers` for
pre-flight, post-flight, migrate, reset and report, `plugins` for the audit (one
entry per plugin, not per provider), `updates` for link.

`--report` uses `verdict: "REPORTED"` — it is a survey, so there is no pass or fail
to report. Its `providers[]` entries carry **either** `comparison` (migrated: the
real field-by-field result) **or** `billing_readiness` (not migrated: what billing
info holds), never both, so a consumer cannot mistake a billing-side assessment for
a check against a real entity. `scope` records everything the country filter
excluded. Pre-flight also carries `kyc`, where
`exact: false` means the database cannot settle the answer and the
adyen-platform RPC is authoritative — do not read it as decided.

Pre-flight's `kyc` array covers only the providers the gate applies to, so it carries
`kyc_excluded_countries` alongside — the `NO_KYC_COUNTRIES` markets in scope. It is `[]`
for an ordinary run; where every provider is in such a market, `kyc` is `[]` and this names
why, so a short array is never read as the whole provider set.

Post-flight's `providers[]` is one entry per provider, **except** for a provider in
`MULTI_ENTITY_PROVIDERS`, which appears once per plugin — each with its own
`expected_legal_entity_id` and `multi_entity: true`. The flag is absent otherwise, so a
consumer keying on `provider_id` alone can detect the case instead of silently overwriting
one row with the other. `tally` counts distinct providers, matching the screen.

Pre-flight's `skipped[]` holds the providers it could not check, each with
`reason` and `has_billing_details` — the flag that separates "run `migrate`" from
"there is nothing for `migrate` to build from". `tally.no_primary_legal_entity`
counts them.

Built from the same structures the Markdown export uses, never from the rendered
tables: those carry ANSI escapes and column padding, and a value that has been
through a formatter is no longer the value.

## Safety

- **Writes require a terminal** — no TTY, no write, in any namespace. A piped
  `yes` is not approval, and there is no `--force`. `--yes` covers reads and dry
  runs only.
- **Reads are approved before any query**, with the namespace and databases
  shown.
- **Dry run is the default** at every level: the prompt defaults to it, and
  the answer you give at the dry-run-vs-apply prompt is what sets `DRY_RUN`.
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

## Don't write tests for these scripts

**Do not add or extend a test suite here.** Not unit tests, not a harness, not a
"just one case to pin this down" addition to an existing one. If you are tempted to
prove a change works, prove it the way this script is meant to be proven: run a
read-only mode against a real staging namespace and read the output.

```sh
./plugin_legal_entity_updates.js --report -n eng-pierogi --all --detail
./plugin_legal_entity_updates.js --preflight -n eng-pierogi --all --json --yes | jq .tally
```

Every mode that reads is safe to run repeatedly, in production included, so a real
namespace is always available as the oracle — and it exercises the actual psql
queries, the actual jsonb shapes and the actual Houston plumbing, none of which a
fixture reproduces faithfully. `--json` gives you something diffable across two
revisions of the script, which is the closest thing to a regression check that is
worth having here.

`plugin_legal_entity_updates.test.sh` predates this convention. Leave it alone —
don't grow it, and don't treat its existence as licence to add more.

## Prereqs

- VPN up; `houston` authenticated (prod reads use `fresha-production-developer`).
- Node on PATH. Dependency-free.
- Needs psql access to **four** databases in the target namespace — `shedul`,
  `accounting_documents`, `legal_entities` and `adyen_platform` (KYC) — plus permission to run Houston
  tasks on **both** `accounting-documents` (link) and `partners-app` (migrate). (In staging all three are hosted on the same RDS instance,
  `<namespace>-shedul`; the alias still selects the database.)

## Output

Colour follows the convention in `onboard_location_scripts.exs`: **cyan** for a
query about to run, **yellow** for a command you could run yourself, **bright
white** for section headers, **faint** for progress. Every statement is echoed
before it runs — this script reads production, so what it asks for should never
be a mystery. Long `IN (…)` lists are truncated in the echo.

Colour is suppressed when stdout isn't a terminal, or when `NO_COLOR` is set.
