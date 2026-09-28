---
name: audit_it_smart_receipt_errors
summary: Table the IT invoices and credit notes stuck in an error state in Invopop, and aggregate why they failed
domain: e-invoicing
country: IT
integration: smart_receipts
integrator: invopop
env: production
access: read-only
tier: read-only
lang: js
secrets: [SMART_RECEIPTS_READ_ONLY_API_TOKEN]
examples:
  - args: ""
    note: the last 7 days — the table, then the reasons
  - args: "--since 24h"
    note: this morning's failures
  - args: "--since 3mo --scan 20000"
    note: a quarter, with the scan raised to cover it
  - args: "--type credit-notes"
    note: only the refunds
  - args: "--tax-id IT12345678901"
    note: one supplier
  - args: "--no-db"
    note: Invopop only — skip Fresha's document, tracker and sale ids
  - args: "--since 24h --csv"
    note: export the CSV to a temp path and print it
  - args: "--csv ~/Desktop/"
    note: export it somewhere of your own
  - args: "--csv -"
    note: the CSV on stdout, to pipe
  - args: "--report"
    note: also write the Markdown report and the CSV
  - args: "--json --since 24h"
    note: for a script; never prompts
reports: ["it-receipt-errors-*.md", "it-receipt-errors-*.csv"]
related: [lookup_it_smart_receipt, check_invopop_suppliers]
---

# audit_it_smart_receipt_errors

Answers the question `lookup_it_smart_receipt` cannot: *not what happened to this
receipt, but what is going wrong across all of them.* It sweeps the Italian Smart
Receipts workspace for invoices and credit notes that did not land, tables them
with the silo entry each one lives in, and counts the reasons — so a hundred stuck
documents resolve into the three or four faults actually behind them.

The token decides the workspace, and the workspace decides the country — an IT
receipt is not in the ES VeriFactu workspace. The workspace is printed before the
answer so a wrong token is obvious rather than looking like a clean sweep.

## What it does

1. **Whose workspace** — `GET /access/v1/workspace` names the workspace the token
   opens, on stderr.
2. **Sweep the silo** — `GET /silo/v1/entries`, newest first, 100 at a time,
   following `next_cursor`. There is **no state filter on the API**, so finding the
   errors means reading the entries: `--since` is what bounds that work, not just
   what bounds the report. `--scan` is the backstop, and says so out loud when it
   is reached rather than quietly returning less.

   Within one folder the silo answers in creation order, so the cutoff can stop the
   sweep. Across folders it does not: asked for everything it returns one folder's
   list after another's — fifty-four suppliers going back to June, then the day's
   invoices — so `--folder invoices` is the default, and `--folder all` gives up the
   early stop and reads to `--scan`. It also takes a **whole page** older than the
   window to stop, never the first old entry on one; that is what a stray June
   supplier seventeen rows into today's page costs you otherwise.

   The silo has been seen handing back a cursor past the end of the list, so a
   repeated cursor and a page with nothing new on it both end the sweep. A page
   shorter than asked for does not — `limit` is a ceiling, and stopping on one
   would end the sweep in the middle of the window.
3. **Keep the receipts** — a Smart Receipt and a credit note are both GOBL
   `bill/invoice` documents; they differ by the document's `type`, not by where
   they are filed. So the filter is the schema, which is what separates them from
   the parties sharing the silo — and the folder only narrows how much has to be
   read to find them, never what counts as an answer. An entry that failed before
   it was given a schema is kept when it is shaped like a receipt, because those
   are the worst failures and a missing field is no reason to hide them.
4. **Keep the errored ones** — `error`, `rejected` and `invalid` by default;
   `--state` narrows it. The state is on the listed entry, so this costs nothing.
5. **Fetch those again** — the API reference says an entry list includes `data`
   "when fetching … and in entry lists". It does not. A listed entry arrives with
   its snippet and **no envelope and no `faults`**, and taken at its word the sweep
   reports every failure as "(no fault recorded)", names no supplier, and files
   every credit note as an invoice — `type` lives in the envelope too. So each
   errored entry is fetched by id, eight at a time. The error count is what pays
   for that, not the size of the sweep.
6. **Say why** — every `fault` on those entries, grouped and counted.

| bucket | states | meaning |
|---|---|---|
| `✓ ok` | registered, completed, sent, received, paid, accepted, done | the tax authority has it |
| `… pending` | draft, processing, pending, queued, waiting | still on its way; not a problem |
| `✗ error` | error, rejected, invalid | it did not land — the faults say why |
| `⊘ voided` | void, voided, cancelled | cancelled on purpose |

## Invoices and credit notes

The AdE takes a refund back as a corrective document, not as a separate kind of
receipt, so GOBL's `type` is the only thing that tells the two apart:
`credit-note`, `corrective` and `debit-note` are the ones that take money back and
are reported as credit notes; everything else is an invoice. `--type` keeps one
side or the other, and the aggregate always says which kinds a reason struck.

## Aggregating the reasons

A provider's message carries the document it is about — an id, a number, a
timestamp — and grouped verbatim, forty receipts that failed for one reason read
as forty reasons. So the grouping **key** is the provider and fault code, and when
there is no code, the message with its ids and numbers stood down to placeholders.
The table and the report still print the message exactly as the provider sent it,
and say how many other wordings landed under the same key.

A document rejected for two reasons is counted under both, so the reason counts
can add up past the number of documents. `DOCS` is the honest denominator and is
what the rows are sorted and shared by.

## Safety

Read-only, structurally: three GETs and no other HTTP verb anywhere in the file.
`grep -nE "method:|POST|PUT|PATCH|DELETE" audit_it_smart_receipt_errors.js` is the
test, and the one query it sends the warehouse is a SELECT. There is nothing to
dry-run and nothing to confirm.

## Getting from a row to the document

The `SILO ENTRY` column is the console's own address for the entry:

```
https://console.invopop.com/<workspace slug>/silo/<folder>/<entry id>
```

The slug comes from `/access/v1/workspace` and the folder from the entry, so the
link is built out of what the API already answered rather than assumed;
`--console-url` or `INVOPOP_CONSOLE_URL` points it elsewhere. On a terminal the
id is an OSC 8 hyperlink — click it — and piped output carries no escape at all,
because stdout is data there. The Markdown report links the id, and the CSV and
`--json` carry the whole URL in `console_url`.

It has to be built, because an errored entry has **no links of its own**: no meta
rows, no attachments, and `link_url` empty across every entry in the workspace.
Those arrive only once AdE accepts the document, when it gains a `ticket-it/ade-ref`
meta row and a PDF — which is one more way of seeing that the errored ones never
landed.

## Fresha's own ids

A silo entry says what happened; it does not say what to do about it. The ids a
retry is driven by live on Fresha's side, so by default the errored receipts are
looked up in **Snowflake Postgres** through the Metabase CLI (`mb query`, database
87), joining `PUBLIC_ACCOUNTING_DOCUMENTS` to its latest tracker and to
`PUBLIC_ACCOUNT_CONFIGURATIONS`, and the table gains three columns: the accounting
**document** id, the **latest tracker** id (`LATEST_TRACKER_ID`) and **`sale_id_64`**.
`--no-db` skips it. `upload_status` and `review_status` come back in the same row
and are carried in the CSV and `--json` — worth reading, because a receipt Invopop
calls `error` is routinely `sent` / `rejected` here: Fresha uploaded it and the tax
authority refused it.

`RECEIPT_NUMBER` holds the bare code — `INV01406`, not `FT-INV01406` — and the same
code comes round again for other suppliers and other countries: `INV01166` alone
answers for eight configurations across IT and ES. So every receipt is asked for as
its code **and** its supplier's tax ID, matched on letters and digits alone and
with or without the country in front, since the warehouse stores it both ways. One
document per receipt, newest by id; where a supplier has issued the same number
before, the id is printed with a trailing `?` and the note says so. All of it is
one query, sent only about the receipts that failed, and refused past 200 of them.

A missing or logged-out `mb` is reported and stepped over — three empty columns
beat an audit that prints nothing because a second system was unreachable.

## Prereqs

- Node ≥ 20 on PATH (uses the built-in `fetch`; no dependencies).
- `SMART_RECEIPTS_READ_ONLY_API_TOKEN` — the read-only token for the **Italian**
  workspace. `ops run` asks for it once and saves it (`ops help credentials`); run
  directly, it prompts with the echo off.
  `INVOPOP_API_BASE_URL` or `--base-url` points at somewhere other than
  `https://api.invopop.com`.
- For the Fresha ids only: the Metabase CLI on PATH (`mb`), logged in once with
  `mb auth login` (`mb auth status` to check). Without it the three columns are
  skipped, not fatal.
- No VPN and no houston: this talks to Invopop and to Metabase, not to Fresha's
  own databases.

## Output

- Two tables on stdout — the documents, then the reasons — and the workspace,
  the window and the scan's progress on stderr.
- `--csv` exports the CSV **instead of** the tables: with no path it writes to a
  fresh directory under the system temp dir, which is usually what you want — the
  file is for the next command, not for the repository — and prints that path on
  stdout so `$(…)` picks it up. A path may be given instead and a directory is
  taken as one, the name staying the script's; `--csv -` writes to stdout to pipe.
  The counts go to stderr either way, where a pipe cannot pick them up.
- `--report` writes `it-receipt-errors-<YYYY-MM-DD>.md` and `.csv` to the cwd and
  keeps the tables. Both it and `--csv` produce the same CSV: one row per fault,
  not per document, so a pivot over the reasons needs no unpacking, carrying the
  configuration id and the upload/review status as well.
- `--json` emits `{workspace, window, scanned, considered, truncated, fresha_error,
  count, reasons[], entries[]}` and never prompts; each entry carries a `fresha`
  object, or `null` when the warehouse was not read.
- Exit 0 when nothing in the window is in an error state, 1 when something is,
  2 when the call was wrong or the token was refused.
