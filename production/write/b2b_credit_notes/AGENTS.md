# b2b_credit_notes

**Env: production.** Given a list of B2B credit notes, work out which invoice each one
belongs to and print the matrix.

> **Why it lives in `write/`.** A mutating mode is planned. The only mode that exists
> today — `matrix` — is **read-only**: `SELECT`s in both databases, no
> `houston psql --write` anywhere in the file. The one thing it writes is the Markdown
> report in your working directory.
>
> `READ_ONLY_MODES` in the script is what enforces this. `matrix` is on that list, so it
> still runs with piped stdin; any mode *not* on the list refuses without a TTY, in every
> namespace. Adding a write mode therefore gates it by default rather than by remembering
> to — and whoever adds one should add its confirmation gate, not just its name.

## Why this exists

A B2B credit note has **no pointer to the invoice it credits.** shedul's
`provider_invoices` has no `original_invoice_id` / `credit_note_id` column. Positive
fee items become an invoice and negative items become a credit note, both for the same
provider and the same billing window — see
`Areas::ProviderInvoicing::CreateProviderInvoiceService#handle_invoice_and_credit_note`
in `app-shedul`. The only correlation is the tuple

```
(provider_id, billing_start, billing_end, billing_document_type)
```

which is exactly what shedul's own unique indexes key on
(`provider_invoices_billing_period_uniq`, `provider_invoices_billing_period_and_status_uniq`).

So the matching has to be reconstructed, across two databases, by hand. This does it.

## Pipeline

Mode `matrix` — the only mode so far. Four queries; the join happens in Node because
`accounting_documents` and `shedul` are separate databases.

1. **`accounting_documents`** — the supplied ids plus their latest `e_invoice_trackers`
   row. This is what confirms the input: `document_type = 'credit_note'`, and
   `einvoice_reference IS NOT NULL` (rather than `sale_id`) for partner billing.
2. **`shedul`** — resolve each credit note through `provider_invoices.einvoice_reference`
   to get the provider, the billing period and the credit note's **value** (summed from
   `provider_invoice_items`). **The provider must come from here** —
   `accounting_documents.provider_id` is NULL for B2B billing documents.
3. **`shedul`** — every invoice belonging to those providers, in **any** billing period.
   The amount constraint is absolute, so the period cannot be used to narrow the query.
   A provider has one invoice per month, so this is tens of rows each.
4. **`accounting_documents`** — the ZATCA tracker status of the matched invoices.

`einvoice_reference` is the join key between the two databases: a uuid, uniquely
indexed on both sides.

## Matching

> Candidates are the provider's **e-invoiced** invoices (`einvoice_reference IS NOT
> NULL`). Of those, the invoice's `total` must be **at least the credit note's value**, and
> that holds **regardless of billing period**. Among the ones that qualify: the credit
> note's own period first; then invoices created at or before the credit note, most recent
> first.

The amount is the only hard constraint. The period merely ranks the survivors — a credit
note attaches to its own month's invoice when that invoice is big enough, and reaches
outside only when it isn't. An invoice created *after* the credit note is a last resort,
since one that did not yet exist cannot be the document being credited.

| Outcome | Verdict |
|---|---|
| at least one e-invoiced invoice is large enough | `matched` — highest ranked |
| no e-invoiced invoice of that provider, in any period, is large enough | `UNMATCHED` — the largest available is printed beside it |
| credit note absent from shedul | `ORPHAN` — it exists in `accounting_documents` only |

**Why only e-invoiced invoices.** Without that filter the pool includes the 1 818 690
invoices predating the KSA rollout (`invoice_date <= 2025-06-30`, no reference) and the
1 248 193 `not_applicable` non-KSA ones. Those are **not failed emissions** — the check
for "an e-invoicing provider's invoice, after the cutoff, missing a reference" returns
**0**, so nothing was ever dropped — but matching a ZATCA credit note to a document ZATCA
has never seen is not a useful answer. The filter costs little: of 295 credit notes, 290
match without it and **288 with it**, so exactly **2** are lost.

**`einvoice_status` plays no part in matching.** It is reported, for both documents, and
nothing more. There is deliberately **no `AMBIGUOUS` verdict** — the ranking is a total
order, so it always resolves to one invoice or to none.

### The credit note's value comes from its line items, NOT from `total`

This matters more than anything else on this page. `provider_invoices.total` is **unusable
on credit notes**:

| doc type | rows | `total` = Σ item `fee` | `tax` = Σ item `fee_tax` |
|---|---|---|---|
| invoice | 12 893 | **12 893** (100%) | 12 893 (100%) |
| credit_note | 295 | **15** (5%) | 295 (100%) |

`tax` is right on every credit note; `total` is wrong on 280 of 295, and **281 of 295 have
a `total` exactly equal to an invoice's `total` in the same period** — it carries the
invoice's figure. Worked example, CN/1044 (minor units):

```
pi 3903667  invoice      INV/18589  subtotal 101315  tax  15198  total 116513
            items: 36053 (new_marketplace_customer) + 80460 (add_ons_deduction)
                 = 116513                                                      ✓
pi 3903668  credit_note  CN/1044    subtotal 142600  tax -26087  total 116513
            items: one line, fee -200000 (credit)                              ✗
```

CN/1044 is worth **2 000.00**. Its `total` column says **1 165.13** — `INV/18589`'s
figure, with `subtotal` then back-derived from it, which is why a credit note ends up with
a positive subtotal and a negative tax.

So the script uses `sum(provider_invoice_items.fee)`. Comparing against the stored `total`
would compare an invoice's total with a copy of itself — the test would pass by
construction. Invoice totals **are** self-consistent (12 893/12 893), so the invoice side
uses `total` as stored.

Both sides are compared as **magnitudes** (stored signs are inconsistent — production
holds both `-640653` and `+5175`), in **minor units**, rendered `/100`. No currency
symbol: a billing period can mix issuer and issuee currencies.

### Why a credit note can exceed its month's invoice

`handle_invoice_and_credit_note` splits the month's items by **sign, not by amount** —
positive `fee_sum` becomes the invoice, negative becomes the credit note. They are
different items, and nothing constrains the negatives to be smaller than the positives.

For CN/1044 the invoice held `new_marketplace_customer` + `add_ons_deduction` (1 165.13)
while the credit note held a single `credit` item (2 000.00). A `credit` is an adjustment,
not a reversal of that month's fees, so its size is unrelated to what was billed.

**37 of 295 production credit notes exceed every invoice in their own period.** That is
why the period cannot be a hard constraint, and why the matrix shows both periods with a
`Period` column flagging `same` vs `DIFFERENT`. A cross-period match is a valid result,
not an error — CN/1044 correctly matches `INV/13408` from November 2025, the most recent
invoice of that provider large enough to carry 2 000.00 (April's own was 1 165.13, and
Dec–Mar were all smaller too).

### Known edge case

**194 invoices in `provider_invoices` have a negative `total`** and are therefore never
large enough to carry anything. They stay in the candidate pool and are simply filtered
out by the amount test.

A credit note whose value exceeds every e-invoiced invoice its provider has comes back
`UNMATCHED` — 7 of 295 on production. That is the honest answer; there is no invoice to
point at.

### Why not statuses

An earlier version of this script broke ties by dropping candidates whose
`einvoice_status` was `rejected` or `refunded`, on the strength of shedul's
`INVALID_EINVOICE_STATUSES` constant. That was wrong:

- Nothing in the live codebase ever **writes** `refunded`. `provider_invoice.rb` defines
  constants for `approved`, `pending` and `not_applicable` only, and
  `update_provider_invoice_status_service` writes just `approved` / `rejected`. Every
  `refunded` row shares one `invoice_date` (2025-12-31) — a one-off legacy marker.
- shedul uses that constant to answer a different question ("does this period already
  have an invoice, or should I create one?"), not "which invoice does this credit note
  credit".
- Invoices and their credit notes are created **in the same transaction**
  (`handle_invoice_and_credit_note`), 23–24 ms apart on production. For 43 of the 63
  then-ambiguous credit notes the co-created invoice was the `refunded` one — precisely
  the row the status rule discarded. Three credit notes predated their chosen invoice by
  ten days.

`ledger_month_id` and `issuer_entity_id` were also evaluated as discriminators and are
useless for it: `ledger_month_id` is an exact alias for the period tuple (zero
divergence either way) and the issuer is identical across every multi-candidate period.

Those investigations are kept because they explain why the current rule looks the way it
does — the period was tried as a hard constraint first, and it does not hold.

## Run it

Interactive — it asks for everything:

```bash
./b2b_credit_notes.js
```

Non-interactive — pass `--ids` and `--yes` and it needs no terminal at all:

```bash
./b2b_credit_notes.js --ids 4838124,4838004 --yes --csv
./b2b_credit_notes.js -n eng-orion --ids 123 --yes --no-csv
```

| Flag | Effect |
|---|---|
| `-n, --namespace <ns>` | deploy namespace (default `production`) |
| `--ids <list>` | `accounting_documents.id` values, comma **or** space separated |
| `--mode <mode>` | `matrix` (the only one today) |
| `--csv` / `--no-csv` | write the CSV, or don't — either way, no prompt |
| `-y, --yes` | approve the **reads** without prompting. Read-only modes only; it cannot approve a write. |
| `-h, --help` | usage |

A flag's only job is to suppress its prompt — both paths run the same code afterwards,
so there is no second implementation to keep in step. `--ids` and the prompt share one
parser (`parseIds`), so they accept and reject identically.

**Without a terminal**, the two prompts that have a sensible default take it instead of
aborting: `--mode` falls back to `matrix` and `--namespace` to `production`. That is safe
by construction — `matrix` is read-only, and `requireInteractive()` refuses any mode that
could write when there's no TTY. `--ids` has no default, so omitting it without a
terminal is a usage error that says so. The reads are still gated: no `--yes`, no
queries.

Piping answers in also works, if you'd rather not use flags. The trailing `y` answers the
CSV prompt; leave it off and you just get the Markdown report — a piped run that runs out
of input at that prompt skips the CSV rather than failing, since by then the work is
already done.

```bash
printf '1\nproduction\n4838124, 4838004\n\n1\ny\n' | ./b2b_credit_notes.js
```

## Output

Three renderings of the same rows, from one shared column definition
(`MATRIX_HEADERS` / `matrixCells`) so they cannot drift apart:

| Where | What |
|---|---|
| terminal | box-drawn table; ids and amounts right-aligned |
| `b2b-credit-notes-<namespace>-<YYYY-MM-DD>.md` | always written, in the working directory |
| `b2b-credit-notes-<namespace>-<YYYY-MM-DD>.csv` | written only if you say yes at the prompt |

```
│ Credit note │ …_document_id │ provider_id │ CN month      │ cn_billing_start │ cn_billing_end │ CN total │ Invoice   │ provider_invoice_id │ INV month     │ inv_billing_start │ inv_billing_end │ INV total │ Period    │ … │
│ CN/1044     │       4762934 │     2582590 │ April 2026    │ 2026-04-01       │ 2026-04-30     │  2000.00 │ INV/13408 │             3224290 │ November 2025 │ 2025-11-01        │ 2025-11-30      │   3764.79 │ DIFFERENT │ … │
│ CN/1006     │       4762882 │      769991 │ February 2026 │ 2026-02-01       │ 2026-02-28     │   816.06 │ INV/16204 │             3626340 │ February 2026 │ 2026-02-01        │ 2026-02-28      │  12240.42 │ same      │ … │
```

(17 columns, ~250 characters — wide. It fits the Markdown report and the CSV comfortably;
in a narrow terminal it will wrap.)

- **Credit note** / **Invoice** — the documents' printed `invoice_reference`. A `—` in
  `Invoice` with a `provider_invoice_id` present means the matched invoice has no
  reference because it was never issued — see the edge case above.
- **accounting_document_id** — the id you supplied
- **provider_invoice_id** — the matched shedul row
- **CN total** — summed from `provider_invoice_items`, as a magnitude. **Not**
  `provider_invoices.total`; see the section above for why that column is unusable here.
- **INV total** — `provider_invoices.total` as stored, which is reliable for invoices
- **cn_billing_start/end** and **inv_billing_start/end** — both periods in full, because
  they frequently differ
- **CN month** / **INV month** — the same periods in English, e.g. `April 2026`. Derived by
  slicing the date strings, not via `Date` (a bare `YYYY-MM-DD` parses as UTC midnight and
  would slip a month west of Greenwich) and not via `toLocaleString` (locale- and
  ICU-dependent). A period straddling a boundary shows both names, `April – May 2026`;
  none currently do, but the value is derived rather than assumed.
- **Period** — `same` or `DIFFERENT`, so a cross-period match is obvious without diffing
  four dates by eye
- **CN / Invoice status** — shedul `einvoice_status`, then the ZATCA tracker as
  `review_status/upload_status`. A dash means there is no tracker. Two different
  questions — "did we bill it" and "did ZATCA take it" — so they stay side by side.
- **Match** — the verdict above

There is no `invoice_date` column: it equals `billing_end` on every production row, so
with both periods shown in full it carried nothing and cost width.

Under the matrix, a second table lists any `UNMATCHED` credit note with the **largest
invoice the provider has** — the reason it is unmatched. The Markdown report adds the
excluded input as a third table.

The CSV writes an **empty cell** where the tables show `—`, so a missing invoice sorts
and filters as absent rather than as text. Quoting is RFC 4180.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | every supplied credit note matched an invoice |
| `1` | anything unresolved — `UNMATCHED`, `ORPHAN`, or input that wasn't a B2B credit note |
| `2` | the call was wrong, or approval was refused |

## Safety

- Read-only. `SELECT`s only, both databases. There is no write path — no
  `houston psql --write` anywhere in the file.
- Every statement is echoed before it runs.
- A confirmation gate before the first query; on production a bare Enter **cancels**.
- Every interpolated value is validated first: ids and `provider_id` as integers,
  `einvoice_reference` against a uuid pattern, dates against `YYYY-MM-DD`.
- Reads are chunked at 500 ids per statement, so a long paste doesn't produce one
  enormous unreadable query.

## Prereqs

- `node` on PATH (runtimes pinned via `.tool-versions`). No dependencies.
- VPN up and `houston` authenticated — prod reads use the `fresha-production-developer`
  profile.
