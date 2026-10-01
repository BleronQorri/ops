---
name: lookup_es_verifactu_invoice
summary: Find one ES Verifactu invoice or credit note in Invopop by its number and report its state, faults and links
domain: e-invoicing
country: ES
integration: verifactu
integrator: invopop
env: production
access: read-only
tier: read-only
lang: js
secrets: [INVOPOP_API_TOKEN]
examples:
  - args: ""
    note: asks for the invoice number, then for a tax ID you can skip
  - args: "INV01118"
    note: the number printed on the invoice
  - args: "--tax-id B85905495 INV01118"
    note: one supplier's invoice, when the number is not unique
  - args: "0192f3a4-5b6c-7d8e-9f01-23456789abcd"
    note: an Invopop entry UUID goes straight to the entry
  - args: "--db --config 484 INV01118"
    note: both sides — Fresha's own row and Invopop's
  - args: "--json INV01118"
    note: for a script; never prompts
related: [check_invopop_suppliers, lookup_it_smart_receipt]
---

# lookup_es_verifactu_invoice

Answers one question: *what happened to this invoice?* Give it the number printed
on a Spanish invoice or credit note and it finds the document in Invopop's ES
Verifactu workspace and says what state it is in, what went wrong if anything, and
where to look next.

It is `lookup_it_smart_receipt` pointed at Spain: the same search, the same
exact-match rules, the same Fresha side. The two are kept apart because the token,
the tax ID shapes and the workspace differ, and a lookup that serves both
countries would have to guess which one it was asked about.

The token decides the workspace, and the workspace decides the country — an ES
invoice is not in the IT Smart Receipts workspace. The workspace is printed before
the answer, and a token that opens a workspace whose country is not `ES` gets a
warning, so a wrong token is obvious rather than looking like a missing invoice.

## What it does

1. **Whose workspace** — `GET /access/v1/workspace` names the workspace the token
   opens, and warns when its country is not ES.
2. **Find it** — a UUID goes straight to `GET /silo/v1/entries/{id}`. Anything
   else is a free-text search, `GET /silo/v1/search?q=…`, over every document in
   the workspace, so a series and code, or a bare code, both work. `--folder`
   narrows it.

   The search answers 100 at a time and every page is read before anything is
   judged, up to `--scan` (default 500): the match may sit on page two. `--limit`
   caps what is *reported*, never what is searched.

   The search is free text, so asking for `INV01118` also answers with
   `INV011180`. Only documents whose number really is the one asked for are
   reported — the code, the series and code joined, or the entry UUID. When
   nothing is numbered exactly that, it says what the near misses were numbered,
   and `--loose` reports them.
3. **Whose invoice** — an invoice number is only unique within a supplier. On a
   terminal it asks for a tax ID (Enter means every supplier); `--tax-id` skips
   the question. Matching is exact on letters and digits: `ESB85905495`,
   `B85905495` and `B-8590549 5` are one NIF, but a suffix of it is not. A NIF
   that starts with a letter of its own (`B…`, `X…`) keeps it — only a leading
   `ES` is treated as the country. Matches from more than one supplier are printed
   in a section each.
4. **Fetch what the search left out** — a search hit does not always carry the
   document, so thin hits are fetched again by id, eight at a time. A hit whose
   snippet names a different code is dropped unread.
5. **Say what state it is in** — the silo `state`, bucketed the way
   `check_invopop_suppliers` buckets it, with the series and code, the issue date,
   when Invopop first saw it, any `faults` the provider (AEAT, via Invopop)
   returned, and any `link_url` on the entry's meta rows.

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
`PUBLIC_E_INVOICE_TRACKERS` row and to `PUBLIC_ACCOUNT_CONFIGURATIONS`. That gives
the document id, the configuration and its plugin id, the provider, the tracker's
upload and review status, and the tax ID the configuration carries — which is
then used to pick the right supplier in Invopop, but only when every row agrees on
one. `--config` takes either the configuration id or its plugin id.

A missing or logged-out `mb` is reported and stepped over; the Invopop half of the
answer still stands. An `upload_status` of `not_started` means it never left
Fresha, so its absence in Invopop is expected.

## Prompts

On a terminal it asks for whatever was not passed — the invoice number, the
supplier's tax ID, whether to read Fresha's own row. Nothing is asked on a piped
stdin or under `--json`: a missing invoice number there is exit 2.

## Safety

Read-only, structurally: GETs only, no other HTTP verb anywhere in the file.
`grep -nE "method:|POST|PUT|PATCH|DELETE" lookup_es_verifactu_invoice.js` is the
test. There is nothing to dry-run and nothing to confirm.

## Prereqs

- Node ≥ 20 on PATH (built-in `fetch`; no dependencies).
- `INVOPOP_API_TOKEN` — the token for the **ES Verifactu** workspace, the same one
  `check_invopop_suppliers` reads. `ops run` asks for it once and saves it
  (`ops help credentials`); run directly, it prompts with the echo off.
  `INVOPOP_API_BASE_URL` or `--base-url` points somewhere other than
  `https://api.invopop.com`.
- For `--db` only: the Metabase CLI (`mb`), logged in with `mb auth login`.
- No VPN and no houston.

## Output

- A short report per matching document on stdout; warnings on stderr.
- `--json` emits `{invoice, tax_id, fresha, workspace, count, entries[]}` and
  never prompts.
- Exit 0 when the invoice was found and is not in an error state, 1 when nothing
  matched or what matched is in one, 2 when the call was wrong or the token was
  refused. An invoice still processing is exit 0.
