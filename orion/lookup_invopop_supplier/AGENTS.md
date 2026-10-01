---
name: lookup_invopop_supplier
summary: Find one ES Verifactu or IT Smart Receipts supplier in Invopop by tax ID and report its registration history
domain: e-invoicing
integrator: invopop
env: production
access: read-only
tier: read-only
lang: js
secrets: [INVOPOP_ES_VERIFACTU_API_TOKEN_RO, SMART_RECEIPTS_READ_ONLY_API_TOKEN]
asks: true
examples:
  - args: ""
    note: asks for the regime, the tax ID, then whether to read Fresha's side too
  - args: "--regime verifactu B85905495"
    note: an ES NIF, with or without ES in front, however it is spaced
  - args: "--regime smart_receipts --db IT04042660920"
    note: both sides — Fresha's plugin and Invopop's entries
  - args: "--regime verifactu --json B85905495"
    note: for a script; never prompts
related: [lookup_invopop_document, check_invopop_suppliers]
---

# lookup_invopop_supplier

Answers one question: *is this supplier registered, and if not, why?* Give it a
tax ID and it finds the supplier's entries in that country's Invopop workspace,
says what state the newest one is in, and lists the older ones as the history
behind it.

`check_invopop_suppliers` answers the same question for every ES supplier at once;
this is the one-supplier version, for when someone hands you a tax ID. Like
`lookup_invopop_document`, it serves every regime Fresha reaches through Invopop,
and the regime is the first question — or `--regime`:

| regime | country | token | tax ID | Fresha plugin integration |
|---|---|---|---|---|
| `verifactu` | ES | `INVOPOP_ES_VERIFACTU_API_TOKEN_RO` | NIF | `verifactu` |
| `smart_receipts` | IT | `SMART_RECEIPTS_READ_ONLY_API_TOKEN` | partita IVA | `smart_receipts` |

## What it does

1. **Which regime** — a picker on a terminal; `--regime` everywhere else, where
   leaving it out is exit 2 rather than a guess.
2. **Whose workspace** — `GET /access/v1/workspace` names the workspace the token
   opens, and warns when its country is not the regime's: a token for the other
   country answers "not found" about every supplier.
3. **Find it** — a free-text search, `GET /silo/v1/search?q=…&folder=suppliers`,
   once for each way of writing the tax ID (as typed, without the country, with
   it), because the index matches what was stored. Hits that came back without
   their document are fetched again by id, since the tax ID lives in it.
4. **Fall back to the folder** — the search index lags, sometimes by half an hour.
   When it finds nothing, the `suppliers` folder itself is read page by page with
   `GET /silo/v1/entries` (up to `--scan`, default 2000). That answer is
   authoritative, only slower, which is why it is the fallback.
5. **Match exactly** — on letters and digits alone, with or without the regime's
   country in front: `ESB85905495`, `B85905495` and `B-8590549 5` are one NIF, a
   suffix of it is not. Only the regime's country is taken as a prefix, so a NIF's
   own leading letter (`B…`, `Y…`) is never mistaken for one.
6. **Report newest first** — each entry's state, bucketed the way
   `check_invopop_suppliers` buckets it (faults make an entry an error whatever
   its state says), with its entry id, key, faults and links. The newest entry is
   the answer; an older failure followed by a success is history, and is said to
   be.

## The Fresha side

`--db` (asked for on a terminal) reads Fresha's own record through the Metabase
CLI: `mb query` against **Snowflake Postgres**, database `87`, for the
`PUBLIC_ACCOUNT_CONFIGURATION_PLUGINS` rows with the regime's integration whose
`PARENT_NUMBER` — or whose configuration's `TAX_ID` or `VAT_NUMBER` — is this tax
ID, normalised the same way (the column is stored as typed, lower case included).
That gives the plugin id, its account configuration, the plugin and third-party
statuses, whether it is the default plugin, and whether the configuration was
deleted or disabled.

A plugin in Fresha with nothing in the right workspace means the registration
never reached Invopop. A missing or logged-out `mb` is reported and stepped over.

## Safety

Read-only, structurally: GETs only, no other HTTP verb anywhere in the file.
`grep -nwE "method|POST|PUT|PATCH|DELETE" lookup_invopop_supplier.js` is the
test (whole words, so the `DELETED_AT` columns it reads do not count). There is
nothing to dry-run and nothing to confirm.

## Prereqs

- Node ≥ 20 on PATH (built-in `fetch`; no dependencies).
- The regime's token (table above). `ops run` asks once for each one that is not
  saved — skip the one you do not need — and passes both in; the script reads only
  the regime's. Run directly, it prompts with the echo off.
- For `--db` only: the Metabase CLI (`mb`), logged in with `mb auth login`.
- No VPN and no houston.

## Output

- Fresha's plugin rows (with `--db`), then the supplier's Invopop entries, on
  stdout; warnings on stderr.
- `--json` emits `{tax_id, workspace, source, status, count, entries[], fresha}`
  and never prompts. `status` is the newest entry's bucket.
- Exit 0 when the supplier was found and its newest entry is not an error, 1 when
  nothing matched or the newest entry is an error, 2 when the call was wrong or the
  token was refused. A registration still processing, or voided, is exit 0.
