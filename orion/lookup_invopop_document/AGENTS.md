---
name: lookup_invopop_document
summary: Find one ES Verifactu invoice or IT Smart Receipt in Invopop by its number and report its state and faults
domain: e-invoicing
integrator: invopop
env: production
access: read-only
tier: read-only
lang: js
secrets: [INVOPOP_ES_VERIFACTU_API_TOKEN_RO, SMART_RECEIPTS_READ_ONLY_API_TOKEN]
examples:
  - args: ""
    note: asks for the regime, the number, then a tax ID you can skip
  - args: "--regime verifactu INV018164"
    note: an ES invoice, by the number printed on it
  - args: "--regime smart_receipts --tax-id IT04042660920 INV01475"
    note: one supplier's IT receipt, when the number is not unique
  - args: "--regime smart_receipts --folder invoices 000123"
    note: narrow it to one silo folder
  - args: "--regime verifactu 0192f3a4-5b6c-7d8e-9f01-23456789abcd"
    note: an Invopop entry UUID goes straight to the entry
  - args: "--regime verifactu --db --config 281 INV018164"
    note: both sides — Fresha's own row and Invopop's
  - args: "--regime smart_receipts --json INV01475"
    note: for a script; never prompts
related: [lookup_invopop_supplier, check_invopop_suppliers, audit_it_smart_receipt_errors, lookup_sa_zatca_document]
---

# lookup_invopop_document

Answers one question: *what happened to this document?* Give it the number
printed on a Spanish invoice or an Italian Smart Receipt and it finds the
document in that country's Invopop workspace, says what state it is in, what went
wrong if anything, and where to look next.

It is one script for every regime Fresha reaches through Invopop, because the
search, the matching rules and the Fresha side are identical; only the token and
the country differ. The regime is the first question — or `--regime` — and it
picks both:

| regime | country | token | the document is a… |
|---|---|---|---|
| `verifactu` | ES | `INVOPOP_ES_VERIFACTU_API_TOKEN_RO` | invoice or credit note |
| `smart_receipts` | IT | `SMART_RECEIPTS_READ_ONLY_API_TOKEN` | Smart Receipt |

The token decides the workspace, and a token that opens the wrong one answers
"not found" about everything. The workspace is printed before the answer, and a
workspace whose country is not the regime's gets a warning. KSA goes through
Comarch, not Invopop, and has its own `lookup_sa_zatca_document`.

## What it does

1. **Which regime** — a picker on a terminal; `--regime` everywhere else, where
   leaving it out is exit 2 rather than a guess.
2. **Whose workspace** — `GET /access/v1/workspace` names the workspace the token
   opens.
3. **Find it** — a UUID goes straight to `GET /silo/v1/entries/{id}`. Anything
   else is a free-text search, `GET /silo/v1/search?q=…`, so a series and code, or
   a bare code, both work. `--folder` narrows it.

   The search answers 100 at a time and there are usually more — `INV018164`
   has 284 candidates in the ES workspace. Every page is read before anything is
   judged, up to `--scan` (default 500): the match may sit on page two. `--limit`
   caps what is *reported*, never what is searched.

   The search is free text, so asking for `INV01118` also answers with
   `INV011180`. Only documents whose number really is the one asked for are
   reported — the code, the series and code joined, or the entry UUID. When
   nothing is numbered exactly that, it says what the near misses were numbered,
   and `--loose` reports them.
4. **Whose document** — a number is only unique within a supplier: `INV018164`
   is two different ES invoices from two salons. On a terminal it asks for a tax
   ID (Enter means every supplier); `--tax-id` skips the question. Matching is
   exact on letters and digits, with or without the country in front — and only
   the regime's country is taken as a prefix, so a Spanish NIF's own leading letter
   (`B85905495`) is never mistaken for one. Matches from more than one supplier are
   printed in a section each.
5. **Fetch what the search left out** — a search hit does not always carry the
   document, so thin hits are fetched again by id, eight at a time. A hit whose
   snippet names a different code is dropped unread.
6. **Say what state it is in** — the silo `state`, bucketed the way
   `check_invopop_suppliers` buckets it, with the series and code, the issue date,
   when Invopop first saw it, any `faults` the provider returned, and any
   `link_url` on the entry's meta rows.

| bucket | states | meaning |
|---|---|---|
| `✓ ok` | registered, completed, sent, received, paid, accepted, done | the tax authority has it |
| `… pending` | draft, processing, pending, queued, waiting | still on its way; not a problem |
| `✗ error` | error, rejected, invalid | it did not land — the faults say why |
| `⊘ voided` | void, voided, cancelled | cancelled on purpose |

## The Fresha side

Invopop only knows what reached it. `--db` (asked for on a terminal) reads
Fresha's own row through the Metabase CLI: `mb query` against **Snowflake
Postgres**, database `87`, joining `PUBLIC_ACCOUNTING_DOCUMENTS` to its latest
`PUBLIC_E_INVOICE_TRACKERS` row and to `PUBLIC_ACCOUNT_CONFIGURATIONS`, kept to
configurations in the regime's country. That gives the document id, the
configuration and its plugin id, the provider, the tracker's upload and review
status, and the tax ID the configuration carries — which is then used to pick the
right supplier in Invopop, but only when every row agrees on one. `--config`
takes either the configuration id or its plugin id.

A missing or logged-out `mb` is reported and stepped over. An `upload_status` of
`not_started` means it never left Fresha, so its absence in Invopop is expected.
A document sent in the last half hour may not be in the search index yet, and the
report says so when Fresha's send is newer than anything Invopop showed.

## Prompts

On a terminal it asks for whatever was not passed, in this order: the regime (a
picker), the number, the supplier's tax ID (Enter for every supplier), whether to
read Fresha's own row. Nothing is asked on a piped stdin or under `--json`: a
missing regime or number there is exit 2.

## Safety

Read-only, structurally: GETs only, no other HTTP verb anywhere in the file.
`grep -nwE "method|POST|PUT|PATCH|DELETE" lookup_invopop_document.js` is the
test. There is nothing to dry-run and nothing to confirm.

## Prereqs

- Node ≥ 20 on PATH (built-in `fetch`; no dependencies).
- The regime's token (table above). `ops run` asks once for each one that is not
  saved — skip the one you do not need — and passes both in; the script reads only
  the regime's. Run directly, it prompts with the echo off.
  `INVOPOP_API_BASE_URL` or `--base-url` points somewhere other than
  `https://api.invopop.com`.
- For `--db` only: the Metabase CLI (`mb`), logged in with `mb auth login`.
- No VPN and no houston.

## Output

- A short report per matching document on stdout; warnings on stderr.
- `--json` emits `{document, tax_id, fresha, workspace, count, entries[]}` and
  never prompts.
- Exit 0 when the document was found and is not in an error state, 1 when nothing
  matched or what matched is in one, 2 when the call was wrong or the token was
  refused. A document still processing is exit 0.
