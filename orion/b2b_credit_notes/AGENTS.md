---
name: b2b_credit_notes
summary: Map each B2B credit note to the invoice it credits, or decode a document's payload_base64 locally
env: production
access: write
tier: read-only
lang: js
also: [decode_payloads.js]
aliases: [b2b]
examples:
  - args: ""
    note: "interactive: asks for the mode, the namespace, then the ids"
  - args: "--ids 4838124,4838004 --yes --csv"
    note: matrix mode, no terminal needed
  - args: "--mode decode --ids 4836650,4762882 --yes"
    note: decode payloads in the local app-accounting-documents checkout
  - args: "-n eng-orion --ids 123 --yes --no-csv"
reports: ["b2b-credit-notes-*.md", "b2b-credit-notes-*.csv", "decoded-payloads-*.csv", "decoded-payloads-*.sql"]
related: [fix_credit_note_references, edit_document_payload, fix_invoice_payloads]
---
# b2b_credit_notes

| Mode | Question | File |
|---|---|---|
| `matrix` | which invoice does each credit note credit? | `b2b_credit_notes.js` |
| `decode` | what is inside a document's `payload_base64` — and what would it look like with that invoice's reference patched into it? | [`decode_payloads.js`](#mode-decode) |

`decode` lives in its own file because it shares nothing with the matching logic but the
psql idiom — it decodes Erlang terms in the service's own BEAM. It is a standalone executable in
its own right; `b2b_credit_notes.js` `require`s it, so `--mode decode` and
`./decode_payloads.js` run the same code rather than two implementations of it.

> **Why they live in `write/`.** A mutating mode is planned. Both modes that exist
> today are **read-only**: `SELECT`s only, no `houston psql --write` anywhere in either
> file. The only things they write are the Markdown report and the CSVs, in your working
> directory.
>
> `READ_ONLY_MODES` in the script is what enforces this. Both modes are on that list; any
> mode *not* on it refuses without a TTY, in every namespace. Adding a write mode
> therefore gates it by default rather than by remembering to — and whoever adds one
> should add its confirmation gate, not just its name.

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

Mode `matrix`. Four queries; the join happens in Node because
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

## Flags and non-interactive use
Interactive — it asks for everything:

```bash
./b2b_credit_notes.js
```

Non-interactive — pass `--ids` and `--yes` and it needs no terminal at all:

```bash
./b2b_credit_notes.js --ids 4838124,4838004 --yes --csv
./b2b_credit_notes.js -n eng-orion --ids 123 --yes --no-csv
./b2b_credit_notes.js --mode decode --ids 4836650,4762882 --yes
./decode_payloads.js --ids 4836650,4762882 --yes        # the same thing, directly
```

| Flag | Effect | Mode |
|---|---|---|
| `-n, --namespace <ns>` | deploy namespace (default `production`) | both |
| `--ids <list>` | `accounting_documents.id` values, comma **or** space separated | both |
| `--mode <mode>` | `matrix` \| `decode` (default `matrix`) | both |
| `--csv` / `--no-csv` | write the CSV, or don't — either way, no prompt | `matrix` |
| `--app-dir <path>` | the `app-accounting-documents` checkout that decodes (default: the sibling checkout, `…/repos/orion/app-accounting-documents/src`; env `ACCOUNTING_DOCUMENTS_DIR`) | `decode` |
| `-y, --yes` | approve the **reads** without prompting. Read-only modes only; it cannot approve a write. | both |
| `-h, --help` | usage | both |

A flag's only job is to suppress its prompt — both paths run the same code afterwards,
so there is no second implementation to keep in step. `--ids` and the prompt share one
parser (`parseIds`), so they accept and reject identically.

**Without a terminal**, the two prompts that have a sensible default take it instead of
aborting: `--mode` falls back to `matrix` and `--namespace` to `production`. That is safe
by construction — both modes are read-only, and `requireInteractive()` refuses any mode
that could write when there's no TTY. The reads are still gated: no `--yes`, no queries.

**`--ids` has no default**, so it is *required* when stdin is not a TTY — the ids cannot be
piped in, because the prompt that would read them is skipped. You get a usage error saying
so, and exit `2`:

```console
$ printf '4838124\n' | ./b2b_credit_notes.js
Error: --ids is required when there is no terminal to prompt on.
```

The one prompt that can still be answered by a pipe is the CSV question, and only because
it has no safety consequence and comes after the work is done (`askOptional`, not `ask`) —
a piped run that runs out of input there skips the CSV rather than failing.

## The queries

Every statement either mode runs is **echoed before it runs** and **recorded in the
output**, so the SQL is never something you have to take on trust:

| Where | What |
|---|---|
| terminal | each statement, cyan, before it executes |
| the Markdown report | a `## SQL executed` section — every statement, in order, with the real `IN` lists |
| `decoded-payloads-<ns>-<date>.sql` | the same, as a runnable file beside the decode CSV |

The decode file includes the matrix statements first, because `--mode decode` runs those to
derive the reference — a file showing only the payload read would misrepresent what the run
did. Verified by replaying an emitted file straight back through `psql`.

[**cross-check.sql**](cross-check.sql) is the curated companion: the same five queries
annotated with what they are for and what would mislead you (§1), **the matching algorithm
reimplemented as SQL** (§2), the co-creation check (§3), and post-write verification (§4).

§2 is the useful one. `pickInvoice` as a `row_number()` window, so `rank = 1` is an
independent answer to the same question — checked against the script on all 34, and the
invoice reference *and* both period dates are identical on every row. It is a hand-maintained
copy and can drift; the emitted `.sql` above cannot.

## Output

Three renderings of the same rows, from one shared column definition
(`MATRIX_HEADERS` / `matrixCells`) so they cannot drift apart:

| Where | What |
|---|---|
| terminal | box-drawn table; ids and amounts right-aligned |
| `b2b-credit-notes-<namespace>-<YYYY-MM-DD>.md` | always written, in the working directory |
| `b2b-credit-notes-<namespace>-<YYYY-MM-DD>.csv` | written only if you say yes at the prompt |

```
│ Credit note │ …_document_id │ cn_provider_invoice_id │ provider_id │ CN month      │ cn_billing_start │ cn_billing_end │ CN total │ Invoice   │ inv_provider_invoice_id │ INV month     │ inv_billing_start │ inv_billing_end │ INV total │ Period    │ … │
│ CN/1044     │       4762934 │                3903668 │     2582590 │ April 2026    │ 2026-04-01       │ 2026-04-30     │  2000.00 │ INV/13408 │                 3224290 │ November 2025 │ 2025-11-01        │ 2025-11-30      │   3764.79 │ DIFFERENT │ … │
│ CN/1006     │       4762882 │                3626341 │      769991 │ February 2026 │ 2026-02-01       │ 2026-02-28     │   816.06 │ INV/16204 │                 3626340 │ February 2026 │ 2026-02-01        │ 2026-02-28      │  12240.42 │ same      │ … │
```

(22 columns, ~330 characters — wide. It fits the Markdown report and the CSV comfortably;
in a narrow terminal it will wrap.)

- **Credit note** / **Invoice** — the documents' printed `invoice_reference`. A `—` in
  `Invoice` with an `inv_provider_invoice_id` present means the matched invoice has no
  reference because it was never issued — see the edge case above.
- **accounting_document_id** — the id you supplied
- **cn_provider_invoice_id** — the credit note's own `provider_invoices.id`, so both
  documents can be looked up in shedul without a second query. `—` on an `ORPHAN`, which by
  definition has no shedul row.
- **inv_provider_invoice_id** — the matched invoice's `provider_invoices.id`. Named for its
  side: this column was a bare `provider_invoice_id` while the credit note's was absent, and
  with both present that name would have been a coin toss.

  Worth knowing: **a co-created pair gets consecutive ids**, because the invoice and its
  credit note are inserted in one transaction — `3903667`/`3903668` for `INV/18589`/`CN/1044`,
  `4284689`/`4284690` for `INV/21396`/`CN/1107`. Adjacency is therefore a cheap eyeball
  check for "was this the co-created invoice", and its absence is the signal that the match
  reached outside the period.
- **own_period_invoice_id** — the `provider_invoices.id` of the largest invoice in the credit
  note's own period, reported whether or not it won.
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
- **Own-period invoice** / **Own-period total** — the biggest invoice in the credit note's
  own month, shown even when the match went elsewhere. If any own-period invoice had been
  large enough the ranking would have chosen it, so the largest is the relevant one.
- **Why not own period** — `own period`, or the reason it lost: `own period too small:
  1165.13 < 2000.00`, or `no invoice in April 2026`. A cross-period match is a valid result
  but always has a reason, and the reason is always an amount or an absence — so it is
  stated rather than left to be inferred from four dates and two totals.
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

## Mode: decode

`decode_payloads.js` — what is inside a document's `payload_base64`, and what would it look
like with the matched invoice's reference in it?

```bash
./b2b_credit_notes.js --mode decode --ids 4836650 --yes   # decode AND patch
./decode_payloads.js --ids 4836650 --yes                  # decode only
```

The two are **not** interchangeable: patching needs the matrix, so the standalone file
decodes and stops. See [the patch](#the-patch-previous_receipt_number).

`accounting_documents.payload_base64` is

```
Base.encode64(:erlang.term_to_binary(%AccountingDocuments.Structs.BillingDocument{}))
```

written once at document creation
(`create_accounting_document_and_tracker_action.ex:235`). Every value starts `g3` — `0x83`,
the Erlang External Term Format version byte. **Nothing but a BEAM can read it**, which is
why inspecting one has until now meant the by-hand procedure in
[edit_document_payload](../edit_document_payload/) §2–§3: pull the base64 with psql, start an
IEx shell in the service's checkout, paste it in, read the `inspect` output. Fine for one
document, useless for thirty-four. This does the same three steps for a list of ids.

### Where the decode happens, and why

| | |
|---|---|
| payloads read from | `--namespace`, default **production** |
| decoded in | `--app-dir`, default the sibling `app-accounting-documents` checkout |

Decoding is a pure function of the bytes, so it needs a BEAM with the service's modules and
nothing else — no cluster, no database. The service's own checkout next door is exactly
that, so that is where it runs:

```bash
cd ../../orion/app-accounting-documents/src && mix run --no-start -e '<decoder>'
```

**`--no-start`, so nothing starts.** `mix run --no-start` compiles if needed and puts every
umbrella app's modules on the code path — `Decimal`, `Jason`, `Plug.Crypto`,
`BillingDocument` — but starts no application: no Repo, no consumers, no network. The
production payloads on stdin are the only production data involved. It is the scripted form
of the IEx shell the runbook opens by hand (`iex -S mix run --no-halt` in the same
directory), without the REPL state.

This replaces an earlier path that borrowed a staging pod through
`houston console eng-orion accounting-documents -- <release> eval`. That needed cluster exec
rights, a release path read out of `/proc/1/cmdline` that moved with every redeploy, and a
`--pod-namespace` that had to be staging because the `accounting-documents` component does
not exist in production. None of that is needed to decode bytes.

For a different service, point `--app-dir` at that service's checkout instead; anything with
the payload's modules on its code path will do.

**The checkout must have its deps fetched** (`mix deps.get`). The script never fetches,
compiles into a different profile, or writes anything there. It also does not read
`mise.toml` if `mise` is on your PATH — mix is then run through `mise x --`. Under asdf,
where `mise.toml` is invisible, the pinned Elixir/Erlang from that file are exported as
`ASDF_ELIXIR_VERSION` / `ASDF_ERLANG_VERSION` (falling back to the newest installed build
of the same line), so a bare `mix` does not fail with "No version is set". Export either
variable yourself and it is left alone.

**The payloads travel on stdin.** base64 contains `+`, `/` and `=`, and 34 payloads is
~140 KB — argv is the wrong channel on both counts. `IO.read(:stdio, :eof)` inside the
evaluated program reads a piped payload correctly.

**The decoder answers in JSON, not pipe-delimited.** The *answer* is Elixir — an `inspect`ed
term, which is exactly what lands in the CSV — but it needs an envelope to travel in, and
every obvious delimiter occurs inside the payload. Party names are free text out of provider
records, and document 4836650's issuee is literally

```
Atira Beauty Lounge | اتيرا بيوتي لاونج
```

— a pipe, inside a field. The `parseRows` convention the psql reads here use would have
split that row silently. Addresses carry commas; a pretty-printed term is full of newlines.
`Jason.encode!/1` escapes precisely those, so the decoder emits one `ROW <json>` line per
document and Node unwraps it. The prefix also discards everything else mix prints — compile
progress, config warnings, Logger chatter. No JSON reaches the CSV.

`Plug.Crypto.non_executable_binary_to_term/1` does the decoding — it refuses anonymous
functions and other executable terms, and it is what production itself uses (`submission.ex:255`).
These payloads come from our own database so plain `:erlang.binary_to_term/1` would do, but
a decoder that cannot be talked into evaluating something is the better habit.

Batched at **200 documents per mix invocation**, because each `mix run` boots a VM and loads
the umbrella, several seconds a time — but not unbounded, which would mean an unbounded term
list in memory and one enormous blob of output. Decode failures are per
document (`try/rescue`), so one bad payload costs you that row and not the batch.

### Output

`decoded-payloads-<namespace>-<YYYY-MM-DD>.csv`, plus each document's term printed in full
on the terminal. Fourteen columns, **one record per document** — a decoded document is a tree,
and flattening it into columns would mean choosing which fields matter, so the whole term
goes in instead:

| Column | |
|---|---|
| `accounting_document_id` | the id you supplied |
| `credit_note_reference` | the credit note, e.g. `CN/1107` (`accounting_documents.receipt_number`) |
| `latest_tracker_id` | `accounting_documents.latest_tracker_id` — for the resend, not the write. See below. |
| `cn_billing_start` / `cn_billing_end` | the credit note's billing period |
| `invoice_reference` | the invoice it credits, e.g. `INV/21396` |
| `inv_billing_start` / `inv_billing_end` | that invoice's billing period |
| `decoded_payload_pretty` | the decoded term, pretty-printed |
| `previous_receipt_number` | the reference written into the payload |
| `modified_payload_pretty` | the patched term, pretty-printed |
| `base64_new_payload` | the patched term re-encoded — what a write would use |
| `houston_task_command` | the command that would write it. **Not run.** |
| `decode_snippet` | paste-into-IEx form of the patched payload: assign, decode, inspect |

**`latest_tracker_id` is for the step after the payload write.** Patching the payload is
half the job — the document still has to be re-driven, and
`retry_sending_failed_accounting_documents` silently drops anything whose tracker is not
`failed_to_send`/`rejected` while still reporting success
(`retry_sending_failed_accounting_documents_action.ex:43-52`; `FORCE=true` does **not**
bypass it). Putting a tracker back into an eligible state takes
`update_einvoice_trackers_status -p E_INVOICE_TRACKER_IDS=<id>`, and this is that id. It is
in the CSV so the whole sequence can be assembled from one file rather than a second query
per document, mid-runbook. Empty means the document has no tracker at all — a different
problem from a tracker in the wrong status, so it is not defaulted; the terminal table
shows `none`.

**Both periods are given in full, deliberately.** A cross-period match is a legitimate
result — the amount is the only hard constraint — so the reader gets the two periods to
judge rather than a verdict. On the 34: **29 same-period, 5 cross-period.**

`previous_receipt_number` and `invoice_reference` hold the same string today. They are
separate columns because they are separate facts — "the invoice this credit note credits"
and "the payload field being written" — and collapsing them would hide it if they ever
stopped coinciding.

> ⚠ `credit_note_reference` was called `invoice_reference` in the first version of this
> script, which was actively misleading — it holds `CN/1107`. The matched invoice now has
> that name. Anything built against the old header needs renaming.

Everything from `invoice_reference` rightwards is empty on a run with no matrix to draw on:
`./decode_payloads.js` standalone, or a credit note the matrix could not match. See
[the patch](#the-patch-previous_receipt_number) below.

⚠ **Read it with a real CSV parser, never by splitting on newlines.** The term is
pretty-printed, so that cell always spans lines — legal RFC 4180 inside a quoted field, and
Sheets, Excel and every language's `csv` module handle it, but it means the file has far
more physical *lines* than *records*, and `grep` on a line basis will not work. Measured on
the 34-document cohort: **2380 physical lines, 34 records.**

There is deliberately no second single-line copy of the term. It was there initially, to
keep the file greppable, and it doubled the width of every row to say the same thing twice.

### The patch: `previous_receipt_number`

This is the field all 34 rejected credit notes are missing, and the reason ZATCA returns
`BR-KSA-56`. `decode` sets it to **the matched invoice's
`accounting_documents.receipt_number`** and hands back the re-encoded payload.

**Where the reference comes from.** The matrix, unchanged — `--mode decode` runs
`computeMatrix()` first and prints it, so the value written into each document is visible
beside the evidence for it. `pickInvoice` is not duplicated anywhere: a second copy of that
ranking could drift and put the wrong invoice number into a tax document, which is the one
kind of duplication worth avoiding here. That is also why the patch is only available
through `b2b_credit_notes.js`; `./decode_payloads.js` on its own decodes and stops, because
a lone document id carries no way to know what it credits.

**Read from `accounting_documents`, not shedul.** `provider_invoices.invoice_reference` and
`accounting_documents.receipt_number` agree on all 34 — verified, zero divergence — but the
field is consumed by the e-invoicing side, so the e-invoicing side's column is the
authoritative one. A mismatch is reported (`accounting_documents wins`) rather than assumed
away, because it would otherwise produce a valid-looking document citing an invoice number
the tax authority cannot resolve.

**The patch is a map update**, `%{doc | previous_receipt_number: ref}` — it preserves every
untouched field and raises on a typo'd key instead of quietly adding one.

⚠ **Byte length and md5 change even when nothing meaningful does**, because
`term_to_binary` does not preserve map key order. On these 34 the payload grows by exactly
12 bytes. **Never use length or a digest as a correctness check** — decode and compare
terms. Three assertions run in the same VM that produced the bytes:

| Assertion | |
|---|---|
| `round_trip_ok` | decoding the new base64 yields exactly the patched term |
| `only_field_changed` | nothing but `previous_receipt_number` differs from the original |
| `was_nil` | the field was empty beforehand — nothing is being overwritten |

A row failing either of the first two is **dropped**, not reported with a caveat: its
base64 is a candidate for a production write, and half-verified bytes are worse than none.
`was_nil` is reported rather than enforced, since re-running over an already-patched
document is legitimate.

#### Cross-checking the match itself

The assertions below prove the *bytes* are sound. They say nothing about whether `CN/995`
really credits `INV/13408`. There are two checks for that, and they are independent of each
other as well as of the script.

**The algorithm, reimplemented.** [cross-check.sql](cross-check.sql) §2 expresses
`pickInvoice` as a `row_number()` window — same hard filter, same four ranking keys — so
`rank = 1` is a second answer to the same question, arrived at by a different route. Run on
all 34: **34/34 identical**, matching on the invoice reference and on both period dates.
That catches a transcription or ordering bug in either implementation; it cannot catch a
wrong *rule*, since both encode the same one.

**Co-creation** is the check that owes the rule nothing at all.

`handle_invoice_and_credit_note` splits a month's items by sign inside a single transaction,
so a credit note's invoice — when the month has one — was written milliseconds earlier by
the same code path. That is an opinion formed with no reference to the amount rule, which
makes it a real check rather than a restatement:

```sql
-- houston psql production shedul
WITH cn AS (
  SELECT c.id, c.provider_id, c.billing_start, c.billing_end, c.created_at,
         c.invoice_reference AS cn_ref,
         abs(coalesce((SELECT sum(fee) FROM provider_invoice_items
                       WHERE provider_invoice_id = c.id), c.total)) AS cn_value
  FROM provider_invoices c
  WHERE c.einvoice_reference IN (<the credit notes' einvoice_references>)
    AND c.billing_document_type = 'credit_note'
)
SELECT cn.cn_ref, cn.cn_value / 100.0 AS cn_value,
       coalesce(i.invoice_reference, '(none)') AS co_created_invoice,
       i.total / 100.0 AS inv_total,
       round(extract(epoch from (i.created_at - cn.created_at)) * 1000) AS ms_apart,
       (i.total >= cn.cn_value) AS big_enough
FROM cn
LEFT JOIN provider_invoices i
  ON i.provider_id = cn.provider_id
 AND i.billing_document_type = 'invoice'
 AND i.billing_start = cn.billing_start
 AND i.billing_end   = cn.billing_end
 AND abs(extract(epoch from (i.created_at - cn.created_at))) < 5
ORDER BY cn.cn_ref;
```

Result on the 34: **29 agree exactly**, at 27–129 ms apart, the invoice always written
*before* the credit note. All five divergences are the documented case, and they are exactly
the five cross-period matches:

| Credit note | value | chosen | co-created | co-created total | big enough? |
|---|---|---|---|---|---|
| CN/995 | 2000.00 | INV/13408 | INV/15802 | 1642.95 | no |
| CN/1018 | 2000.00 | INV/13408 | INV/16682 | 892.58 | no |
| CN/1044 | 2000.00 | INV/13408 | INV/18589 | 1165.13 | no |
| CN/994 | 459.77 | INV/14691 | INV/15787 | 314.90 | no |
| CN/1098 | 278.00 | INV/18891 | **(none)** | — | — |

The first four are the rule working as specified: the co-created invoice is too small, so the
match reaches outside the period. `CN/1098` is different and worth knowing about — its
provider has **no invoice in the credit note's own month at all**. The nearest is `INV/19891`
for May at **277.18** against a credit note of **278.00** — short by 0.82 — so even the
adjacent month cannot carry it and the match lands three months back. Not an error, but the
thinnest justification in the cohort.

**What this does not prove.** Co-creation is unavailable precisely where the answer is least
obvious: a credit note whose own month has no invoice, or whose invoice is too small, has no
co-created counterpart to agree with. For those five the amount rule is the only evidence
there is. The definitive check is [ZATCA's own](#end-to-end) — below.

#### Verified on the full cohort

All 34 payloads were re-read from the CSV, paired with the originals straight out of
production, and checked independently of the assertions above:

```
was nil before                          PASS  (34/34)
now set                                 PASS  (34/34)
only that field changed                 PASS  (34/34)
still a BillingDocument struct          PASS  (34/34)
re-encode lossless                      PASS  (34/34)
still :credit_note / :b2b               PASS  (34/34)
line items unchanged                    PASS  (34/34)
all_lines/1 non-empty                   PASS  (34/34)
distinct references: 32
```

`all_lines/1 non-empty` is in there because a document with no lines is **silently
skipped** at submission — `Submission.submit/2` returns `{:ok, :not_sent}` and logs
"has no line items" (`submission.ex:36-48`). A resend would appear to succeed while doing
nothing.

**32 distinct references for 34 documents.** `4762877` (CN/995), `4762909` (CN/1018) and
`4762934` (CN/1044) all resolve to `INV/13408` — 6 000.00 of credits against one 3 764.79
invoice. The matcher is behaving as specified (all three exceed every invoice in their own
period), but three credit notes citing one invoice as BT-25 may be refused for a fresh
reason. Nothing else collides. [fix_credit_note_references](../fix_credit_note_references/)
holds these three out of any first batch — that advice stands.

#### The write — emitted, never run

`houston_task_command` holds the exact invocation that would put the patched payload into
the database, one document per row:

```bash
houston task run accounting-documents-web --namespace production \
  update_accounting_document_payload \
  -p ACCOUNTING_DOCUMENT_ID=4836650 \
  -p PAYLOAD_BASE64='g3QAAAAR…' \
  --no-tui -w
```

The chain, read out of `app-accounting-documents` rather than assumed:

| Step | |
|---|---|
| `houston task run <service> update_accounting_document_payload` | `-p KEY=VALUE` becomes an env var on the Job |
| `run_task.sh:27` | the name is whitelisted; an unlisted one exits 1 with a message |
| `accounting_documents_runner.ex:138` | `AccountingDocumentsRunner.update_accounting_document_payload()` |
| `update_accounting_document_payload_task.ex` | reads both params with `System.get_env/1` |

⚠ **That task validates nothing.** It does not decode the string, check that it is base64,
or look at the document's type or state — it is
`Ecto.Changeset.change(%{payload_base64: payload}) |> Repo.update()`. Whatever you pass is
what lands. Its `@moduledoc` is also stale: it claims the payload is a
`Events.Sales.SaleCreated.V1.Payload`, and it is a `BillingDocument`.

**One document per invocation.** The task takes a single `ACCOUNTING_DOCUMENT_ID`; there is
no batch form, and looping in a shell would lose the ability to stop after the first.

**Rollback is the original payload**, fed back through the same task. `decoded_payload_pretty`
is not enough for that — it is a rendering, not bytes. Keep a copy of the original
`payload_base64` before writing (`edit_document_payload` §2 shows the read).

The service is `accounting-documents-web` on production and `accounting-documents`
elsewhere, the same split as the console component; `--task-service` overrides it. On the
terminal the base64 is elided to `'<3336 chars — see CSV>'` because it would bury
everything else — the CSV column carries it whole.

The payload is **single-quoted**, which is safe because the value is validated against the
RFC 4648 alphabet first (`guardBase64`): base64 cannot contain a quote, a space or a shell
metacharacter, so it cannot break out of the quoting. Verified on all 34 — each command is
one line with exactly two quotes, tokenises into 10 shell arguments, and the quoted value is
byte-identical to that row's `base64_new_payload`.

#### End to end

The only check that settles it is the tax authority's. Once the builder ships and a document
has been patched and re-driven, re-run **matrix** mode over the same ids and read the
`CN status` column: `rejected (rejected/rejected)` → `approved (approved/sent)`.

```bash
./b2b_credit_notes.js --ids <the cohort> --yes --no-csv
```

Everything above is a proxy for that. A patched payload that ZATCA still rejects with
`BR-KSA-56` means the builder change did not take; one rejected with a *new* code means the
reference was accepted and something else is wrong — most plausibly the three credit notes
citing `INV/13408`, which is why they are held out of any first batch.

**This mode still writes nothing.** And the write remains blocked on the
`b2b_credit_note_xml_builder.ex` change: a payload carrying a reference is inert while the
builder cannot emit `<Reference>`, so running these commands today would change the column
and fix nothing. See [fix_credit_note_references](../fix_credit_note_references/).

### What a B2B credit note payload looks like

Worked example — `4836650` / `CN/1107`, the phase-2 pilot, abridged:

```elixir
%BillingDocument{
  reference: "56fd4eb0-7113-48b4-9f15-eb6d976bc3f7",   # NOT a sale id — see below
  receipt_number: "CN/1107",
  previous_receipt_number: nil,                        # the BR-KSA-56 field
  kind: :credit_note,
  financial_relationship_type: :b2b,                   # routes to the builder that
                                                       # cannot emit <Reference>
  invoice_date: "2026-07-31T00:00:00Z",
  total_net: Decimal.new("-14.07"), total_gross: Decimal.new("-16.18"),
  issuer: %InvoiceParty{id: 72899, party_type: :fresha, tax_number: "311268874200003", …},
  issuee: %InvoiceParty{id: 1092540, party_type: :provider, tax_number: "311838689200003",
                        company_registration_number: "7037685448", …},
  items: [%Item{name: "Blast email (%{campaign_messages_count} messages) refund",
                quantity: 1, unit_price: nil, unit_gross: Decimal.new("-16.18"),
                tax_items: [%TaxItem{name: "VAT", rate: Decimal.new("15.0"), …}],
                line_id: nil, line_item_id: nil}],
  service_charges: nil, service_charges_net: nil, service_charges_gross: nil,
  location_id: nil
}
```

Three things worth knowing before you read one of these:

- **`reference` is the `einvoice_reference` uuid, not a sale id.** On a B2C sale document it
  holds the sale id as a string; on these it is the uuid, and `sale_id_64` is NULL. Verified
  byte-identical to `accounting_documents.einvoice_reference` on both test documents — which
  means a decoded CSV **joins straight back to the matrix** on that uuid.
- **`InvoiceParty` carries a full address**, not just an id: 14 fields including
  `address: {:ok, "…"}` — a tuple, not a string. The table in
  [edit_document_payload](../edit_document_payload/) §1 understates it.
- **`line_id`, `line_item_id`, `item_type` and `unit_price` are all `nil`**, and
  `service_charges` is `nil` rather than `[]`. These documents come from partner billing,
  not from a sale, so there are no sale lines to point at. Don't match items on
  `line_item_id` here the way the IT runbook does — there isn't one.

## Exit codes

Both modes share these.

| Code | Meaning |
|---|---|
| `0` | `matrix` — every credit note matched an invoice; `decode` — every id decoded |
| `1` | anything unresolved: `UNMATCHED`, `ORPHAN`, input that wasn't a B2B credit note, or an id that could not be decoded |
| `2` | the call was wrong, or approval was refused |

## Safety

- Read-only, both modes. `SELECT`s only; there is no write path — no
  `houston psql --write`, and no Houston task, anywhere in either file.
- Every statement and every mix command is echoed before it runs.
- A confirmation gate before the first query; on production a bare Enter **cancels**.
  It names the databases the chosen mode actually reads, so `decode` does not claim
  `shedul`.
- Every interpolated value is validated first: ids and `provider_id` as integers,
  `einvoice_reference` against a uuid pattern, dates against `YYYY-MM-DD`.
- Reads are chunked at 500 ids per statement, so a long paste doesn't produce one
  enormous unreadable query.
- `decode` runs locally with `mix run --no-start`, so it starts no application and cannot
  reach a database or a cluster.

## Prereqs

- `node` on PATH (runtimes pinned via `.tool-versions`). No dependencies.
- VPN up and `houston` authenticated — prod reads use the `fresha-production-developer`
  profile.
- `decode` additionally needs a local `app-accounting-documents` checkout with its deps
  fetched (`mix deps.get`), and the Elixir/Erlang it pins. No cluster access.
