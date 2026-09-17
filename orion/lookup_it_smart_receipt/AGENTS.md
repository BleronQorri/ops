---
name: lookup_it_smart_receipt
summary: Find one IT Smart Receipt in Invopop by its number and report its state, faults and links
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
    note: asks for the receipt number, then for a tax ID you can skip
  - args: "2024-000123"
    note: the number printed on the receipt
  - args: "--tax-id IT12345678901 000123"
    note: one supplier's receipt, when the number is not unique
  - args: "--folder invoices 000123"
    note: narrow it to one silo folder
  - args: "0192f3a4-5b6c-7d8e-9f01-23456789abcd"
    note: an Invopop entry UUID goes straight to the entry
  - args: "--db --config 484 INV01118"
    note: both sides — Fresha's own row and Invopop's
  - args: "--json 2024-000123"
    note: for a script; never prompts
---

# lookup_it_smart_receipt

Answers one question: *what happened to this receipt?* Give it the number printed
on an Italian Smart Receipt and it finds the document in Invopop and says what
state it is in, what went wrong if anything, and where to look next.

The token decides the workspace, and the workspace decides the country — an IT
receipt is not in the ES VeriFactu workspace. The workspace is printed before the
answer so a wrong token is obvious rather than looking like a missing receipt.

## What it does

1. **Whose workspace** — `GET /access/v1/workspace` names the workspace the token
   opens, on stderr.
2. **Find it** — a UUID goes straight to `GET /silo/v1/entries/{id}`. Anything
   else is a free-text search, `GET /silo/v1/search?q=…`, over every document in
   the workspace, so a series and code, or a bare code, both work. `--folder`
   narrows it.

   The search answers **100 at a time and there are usually more** — `INV01163`
   has 117 candidates. Every page is read before anything is judged, up to
   `--scan` (default 500), because filtering one page looks like an answer and is
   not one: the match may sit on page two. If the cap is ever reached it says so.
   `--limit` caps what is *reported*, never what is searched, and the counts above
   the report are always the true numbers.

   That search is free text: asking for `INV01118` also answers with `INV011180`
   and with anything that merely mentions it. A receipt number names one receipt,
   so the search is treated as a way of finding candidates and only the documents
   whose number really is the one asked for are reported — matched against the
   code, the series and code joined, and the entry UUID. When nothing is numbered
   exactly that, it says how many mentioned it and what they were numbered, and
   `--loose` reports them.
3. **Whose receipt** — a receipt number is only unique within a supplier, so the
   same number can come back for several. On a terminal it asks for a tax ID and
   an empty answer means "every supplier"; `--tax-id` skips the question. Matching
   is exact, on the letters and digits alone: `IT12345678901`, `12345678901` and
   `IT 1234 5678 901` are one registration written three ways, but `2345678901` is
   a different number and does not match — a suffix that quietly answered about
   the wrong supplier would be worse than no answer. Without it, matches from more
   than one supplier are printed in a section each, headed by tax ID and name.

   The country is kept once. GOBL holds it in its own field, but it is routinely
   typed into the code as well — `IT04042660921` alongside country `IT` — which
   would print as `IT IT04042660921` and, worse, file one supplier under two
   headings depending on which way each document happened to be stored. A leading
   country code is dropped when it repeats the country field, and adopted as the
   country when there is none. A code that merely starts with a letter is left
   alone: `ES B85905495` is one letter and stays whole.
4. **Fetch what the search left out** — a search hit carries the entry but not
   always the envelope: the API includes `data` "when fetching … and in entry
   lists", and a search is neither. Anything that came back thin is fetched again
   by id, where the document is always there — otherwise every receipt would look
   as though it had no supplier and no tax ID. That is one GET per candidate, run
   eight at a time; a candidate whose `snippet` carries a `code` that is not the
   one asked for is dropped unread, but a snippet's silence is not evidence and
   those are fetched.
5. **Say what state it is in** — the silo `state`, bucketed the way
   `check_invopop_suppliers` buckets it, with the document's series and code, when
   it was issued, when Invopop first saw it, any `faults` the provider returned,
   and any `link_url` on the entry's meta rows.

| bucket | states | meaning |
|---|---|---|
| `✓ ok` | registered, completed, sent, received, paid, accepted, done | the tax authority has it |
| `… pending` | draft, processing, pending, queued, waiting | still on its way; not a problem |
| `✗ error` | error, rejected, invalid | it did not land — the faults say why |
| `⊘ voided` | void, voided, cancelled | cancelled on purpose |

## The Fresha side

Invopop only knows what reached it. When a receipt never did — `upload_status:
not_started` — its absence there means nothing on its own, and the difference
between "never sent" and "sent and rejected" is the whole question.

`--db` (asked for on a terminal) reads Fresha's own row through the Metabase CLI:
`mb query` against **Snowflake Postgres**, database `87`, joining
`PUBLIC_ACCOUNTING_DOCUMENTS` to its latest `PUBLIC_E_INVOICE_TRACKERS` row and to
`PUBLIC_ACCOUNT_CONFIGURATIONS`. That gives the document id, the configuration and
its plugin id, the provider, the tracker's upload and review status — and the tax
ID the configuration actually carries.

That tax ID is then used to pick the right document out of Invopop, but only when
every row agrees on one: a receipt number repeats across configurations and
countries, and borrowing the first would answer confidently about a supplier
nobody asked after. `--config` narrows to one configuration and takes either its
id or its plugin id, because the sheets people work from carry either and the two
are one apart in a way that invites the wrong one.

A missing or logged-out `mb` is reported and stepped over; the Invopop half of the
answer still stands.

## Prompts

On a terminal it asks for whatever was not passed — the receipt number, then the
supplier's tax ID, which you can answer with Enter to mean every supplier, then
whether to read Fresha's own row too. One
readline interface handles both, closed before the token prompt takes the terminal
raw. Nothing is ever asked on a piped stdin or under `--json`: a missing receipt
there is exit 2, not a question no one can answer.

## Safety

Read-only, structurally: two GETs and no other HTTP verb anywhere in the file.
`grep -nE "method:|POST|PUT|PATCH|DELETE" lookup_it_smart_receipt.js` is the test.
There is nothing to dry-run and nothing to confirm.

## Prereqs

- Node ≥ 20 on PATH (uses the built-in `fetch`; no dependencies).
- For `--db` only: the Metabase CLI on PATH (`mb`), logged in once with
  `mb auth login` (`mb auth status` to check). Without it the flag is skipped, not
  fatal.
- `SMART_RECEIPTS_READ_ONLY_API_TOKEN` — the read-only token for the **Italian**
  workspace. `ops run` asks for it once and saves it (`ops help credentials`); run
  directly, it prompts with the echo off.
  `INVOPOP_API_BASE_URL` or `--base-url` points at somewhere other than
  `https://api.invopop.com`.
- No VPN and no houston: this talks to Invopop, not to Fresha.

## Output

- A short report per matching document on stdout; the workspace line on stderr.
- `--loose` keeps every search hit instead of only the exact ones.
- `--json` emits `{receipt, tax_id, workspace, count, entries[]}` and never
  prompts; each entry carries its supplier's name and tax ID, flat rather than
  grouped, so `jq` does not have to walk sections.
- Exit 0 when the receipt was found and is not in an error state, 1 when nothing
  matched or what matched is in one, 2 when the call was wrong or the token was
  refused. A receipt still processing is exit 0 — that is not a problem yet.
