---
name: audit_tax_identity_drift
summary: "Audit every account_configuration's tax identity against the legal entity its plugins point at, field by field"
env: production
access: read-only
tier: read-only
status: retired
retired_on: 2026-09-10
retired_reason: "Written to survey tax-identity drift during the Billing Profiles rollout; that migration is complete (team-orion #282 and #296) and the survey has served its purpose"
lang: js
examples:
  - args: "--yes"
    note: every row, no terminal needed; writes the Markdown report
  - args: "--country SA --conflicts-only --yes"
    note: one country, only the rows that disagree
  - args: "--provider 646845 --json --yes"
    note: one result document on stdout, human lines on stderr
reports: ["account-config-le-audit-*.md", "account-config-le-audit-*.csv"]
---
# audit_tax_identity_drift

**Read-only, structurally.** There is no `houston psql --write` and no `houston task run`
anywhere in the file. That absence is the safety property; `grep -nE '\-\-write|task run'`
is the test. `--yes` approves the *reads* for automation, and there is no stronger action
it could unlock.

## Why this exists

app-accounting-documents stores a provider's tax identity **twice**:

| where | what |
|---|---|
| `accounting_documents.account_configurations` | `tax_id`, `vat_number`, `company_registration_number`, `country_code` — mirrored onto the plugin as `parent_number` / `branch_number` / `country_code` |
| `legal_entities.legal_entities` | the post-Billing-Profiles system of record, reached via `account_configuration_plugins.legal_entity_id` |

**The two are snapshots, not a link.** `AccountConfigurations.maybe_update_tax_id/2` and
`maybe_update_company_registration_number/2` refresh the columns only on a re-onboarding,
or when an operator runs `UpdateAccountConfigurationTaxIdTask`. Nothing subscribes to
legal-entity change events, so a legal entity edited after onboarding leaves the
accounting-documents columns silently stale.

That still matters even though the payload builders no longer read those columns:

- `tax_id` + `company_registration_number` back the onboarding uniqueness pre-check
  (`get_enabled_plugins_by_tax_id_and_crn/3`). A stale `tax_id` wrongly passes or fails
  the next one.
- the KSA Comarch processor falls back to the configuration's CRN for **Fresha-issued
  B2B** (`resolve_company_registration_number/2`).

`plugin_legal_entity_updates` does **not** answer this question — its pre-flight compares
shedul's `provider_billing_informations` against the legal entity. Nothing anywhere
compared the `accounting_documents` columns themselves, and there is no Houston task that
does it either.

## Pipeline

Two queries; the join happens in Node because `accounting_documents` and `legal_entities`
are separate databases.

1. **`accounting_documents`** — every `account_configurations` row **LEFT JOINed** to
   `account_configuration_plugins`. The LEFT JOIN is deliberate: a configuration with no
   plugin at all is itself a finding, and an inner join would hide it.
2. **`legal_entities`** — the `fields` jsonb of every legal entity those plugins name,
   **root and child**, plus `country_code` / `type` / `business_type` as `_column.*`
   pseudo-keys.

Filtering (`--country`, `--provider`) happens in Node, not SQL: the whole table is 443
rows, and filtering afterwards lets a scoped run still say what it excluded.

## The comparison is PLUGIN-level, not configuration-level

This is not a stylistic choice, and getting it wrong invents a conflict.

Provider **1135636** holds two enabled plugins against one configuration:

| plugin | `is_default` | `branch_number` | legal entity |
|---|---|---|---|
| 12 | `true` | `1010403997` (= the account's CRN) | `01a03382-5190-…` |
| 402 | `false` | `1010880577` (the **branch's** CRN) | `01a03382-5166-…` |

Both are correct. The CRNs are hardcoded in `comarch/billing_details_policy.ex`
(`@ksa_location_branch_numbers`, "Drop with #292"), and a branch plugin's legal entity
carries the branch's own CRN by design. Comparing
`account_configurations.company_registration_number` against every plugin's legal entity
therefore reports plugin 402 as drift. Comparing `plugins.branch_number` does not.

Note `is_default` alone cannot tell the two apart: **default plugins also carry the
account CRN in `branch_number`** — see the comment in `get_account_configuration_query.ex`.
The internal-consistency section is where `is_default` is used, to exempt branch plugins
from the CRN equality check.

## Field map

| accounting-documents | legal-entity slot | identifier kind |
|---|---|---|
| `plugins.parent_number` | `<shape.ident>.vatNumber` | `IDENTIFIER_KIND_TAX_NUMBER` |
| `plugins.branch_number` | `<shape.ident>.registrationNumber` | `IDENTIFIER_KIND_COMPANY_REGISTRATION_NUMBER` |
| `plugins.country_code` | `_column.country_code`, then `<shape.addr>.country` | — |

`<shape.ident>` / `<shape.addr>` are resolved per entity **shape** (`leKeysFor`), so an ES
sole trader reads `soleProprietorship.vatNumber` off the **child** row and an SA
organization reads `organization.vatNumber` off the root.

> **The tax slot is `*.vatNumber`, never `*.taxInformation.number`.** The projection emits
> the former as `IDENTIFIER_KIND_TAX_NUMBER` and the latter as
> `IDENTIFIER_KIND_TAX_IDENTIFICATION_NUMBER` — a different kind, which
> `LegalEntityBillingDetails` does not read for `tax_number`. Probing the TIN slot would
> report a tax number as present that the RPC leaves nil.

> **Sole traders keep their identifiers on the CHILD entity** (`soleProprietorship.*`),
> joined through `legal_entity_associations`. Reading the root alone reports every
> populated ES/IT provider as missing everything. 26 of the 312 comparable production
> plugins are sole proprietorships.

### Not compared, and why

| column | why not |
|---|---|
| `configuration` jsonb | `{}` on all 442 production rows. No embedded schema, no per-country variant, **zero reads anywhere in `src/`**. There is nothing in it to compare. |
| `enabled` | dead — not in the Ecto schema at all. Enablement comes off `plugins.plugin_status`. |
| `vat_number` | a write-only duplicate of `tax_id`: `maybe_update_tax_id/2` sets both from the same `billing_details.tax_number`. Asserted equal in the internal section instead of compared twice. |
| `currency_code` | no legal-entity counterpart. |
| `paused_sending_documents_at` | superseded by the per-plugin column of the same name. |

## Verdicts

| verdict | means |
|---|---|
| `MATCH` | equal after trim / whitespace-collapse / case-fold |
| `PREFIX` | equal under the application's **own** `tax_id_variants/2` normalisation, differing only by the leading ISO country code (`ESB63912596` vs `B63912596`). **Not a discrepancy** — see below. |
| `CONFLICT` | both present, genuinely different. Sub-labelled: |
| ` ↳ CONFIG MALFORMED` | the accounting-documents value fails the country format rule and the legal entity's passes — the column is corrupt, the entity is right |
| ` ↳ LE MALFORMED` | the reverse |
| ` ↳ BOTH MALFORMED` | neither side is usable |
| ` ↳ BOTH VALID` | two well-formed values naming different things — needs a human |
| `LE ONLY` / `CONFIG ONLY` | one side has it, the other doesn't |
| `NEITHER` | both empty |
| `NO SLOT` | the entity shape has no key for the field. An `individual_trust` emits **no identifiers at all** (`identifier_keys/2` returns `[]`), so a tax number can never live there. A fact about the shape, not a missing value. |

`PREFIX` is its own bucket, and does not fail the run, because
`AccountConfigurations.tax_id_variants/2` treats `[value, bare, country_code <> bare]` as
the same value when the application itself looks one up. In production that is 5 rows —
counting them would bury the 12 real conflicts under 5 non-problems. `--include-prefix`
flips it if you disagree.

Format rules come from `AccountingDocuments.Helpers.ValidationHelpers` and are applied to
**both** sides, because which side is malformed *is* the finding:

- `valid_ksa_tax_id?` — `~r/^3\d{12}03$/`
- `valid_ksa_crn?` — exactly 10 characters

## States

Before a field can be compared, the (configuration, plugin) pair has to be one that
*should* have a legal entity.

| state | means |
|---|---|
| `COMPARED` | has a live legal entity; fields were compared |
| `UNLINKED` | provider-side plugin with `legal_entity_id IS NULL`. **A finding** — every integration's `BillingDetailsPolicy` returns `{:error, :missing_legal_entity_id}` and drops the sale — but there is nothing to compare, so it is counted separately. Its `plugin_status` is reported: an `enabled` one is losing live sales, a `failed` one already stopped. |
| `LE MISSING` | `legal_entity_id` is set but names no live row in `legal_entities`. The worst case. |
| `NO PLUGIN` | the configuration has no plugin row at all |
| `FRESHA ENTITY` | an `invoice_entity_id`-keyed configuration. Fresha's own B2B issuer has **no legal entity by design** — `comarch/billing_details_policy.ex` short-circuits `party_type: :fresha` and takes the CRN off the configuration. **Excluded from every tally**, never flagged. |

That last exclusion matters more than it looks: production's single `enabled` plugin with
no `legal_entity_id` (plugin 33) is the Fresha B2B issuer. Counting it as `UNLINKED` would
report a live outage that does not exist.

## Internal consistency

A separate section, accounting-documents against itself, no legal entity involved. These
restate the invariants the service's own `pre_flight_check/0` helpers assert
(`backfill_accounting_document_plugin_id_action.ex`, `backfill_tax_entity_data_task.ex`):

- `tax_id == vat_number`
- `tax_id == plugin.parent_number`
- `country_code == plugin.country_code`
- `company_registration_number == plugin.branch_number` — **`is_default = true` only**;
  branch plugins are listed as exempt with their values shown
- `provider_id == plugin.provider_id` — only when the plugin's is populated. 114
  production plugins carry NULL there, which is a backfill gap, not drift.
- at most one **enabled** plugin per `(country_code, parent_number, branch_number)`,
  per the `unique_tax_entity_per_plugin` partial index

## Output

A summary matrix, per-country verdict tallies, a detail section for every row that didn't
compare cleanly, the internal-consistency section, and a summary. Always writes
`account-config-le-audit-<namespace>-<YYYY-MM-DD>.md`; offers the same table as `.csv`.

The terminal table, the Markdown and the CSV are all generated from **one** column
definition (`MATRIX_HEADERS` + `matrixCells`) and from the row objects — never from the
rendered output, which carries ANSI escapes and padding.

## Exit codes

| code | |
|---|---|
| 0 | clean — no conflicts, no dangling entities, internal checks pass |
| 1 | the data is wrong: a `CONFLICT`, an `LE MISSING`, a failed internal check, or a duplicate tax entity |
| 2 | the call was wrong, or read approval was refused / impossible |

`PREFIX` and `UNLINKED` do not fail the run unless `--include-prefix` is given.

## Production baseline (2026-09-07)

Useful as a regression test — a fresh run should differ only where the data has actually
moved.

443 rows: **312 COMPARED**, **130 UNLINKED**, **1 FRESHA ENTITY**, 0 `LE MISSING`,
0 `NO PLUGIN`. Verdict FAIL, exit 1.

| field | MATCH | PREFIX | CONFLICT | LE ONLY | CONFIG ONLY | NEITHER |
|---|---|---|---|---|---|---|
| tax / VAT no. | 294 | 5 | **12** (all SA) | 0 | 1 | 0 |
| registration no. | 287 | — | 0 | 8 | 1 | 16 |
| country | 312 | — | 0 | 0 | 0 | 0 |

The 12 SA conflicts: **9 `CONFIG MALFORMED`** (`10074505500003` a digit short,
`3109086346` truncated, `357008`, `450714381302` …, each against a well-formed TRN in the
legal entity) and **3 `BOTH VALID`** (`310638951400003` vs `314300709700003`;
`300514139500003` vs `312894287200003`; `310209264600003` vs `312975005300003`).

Internal consistency: **all pass**, with plugin 402 exempted as a branch plugin.
Of the 130 `UNLINKED`, **0 are `enabled`** (102 ES `verifactu`/`failed`, 14 SA
`zatca`/`failed`, the rest `disabled`/`pending`/`paused`).

## Watch out

- **The legal-entity field query MUST keep `WHERE le.id IN (...)` inside both arms of the
  UNION.** Hoisted to an outer filter, `jsonb_array_elements` unnests 246k+
  sole-proprietorship rows and the statement times out. Measured, not hypothetical.
- **The child arm comes LAST**, so on a key collision the child wins. A pre-hierarchy
  `individual` root can carry a legacy `soleProprietorship.vatNumber`
  (`default.ex` `individual_legacy_fields`), and the mapper reads the child's value.
- Both `accounting_documents` / `accounting-documents` work as the `houston psql` argument;
  the underscore form matches the other scripts here.

## Prereqs

VPN up, `houston` authenticated (prod reads use `fresha-production-developer`). Node only,
no dependencies.
