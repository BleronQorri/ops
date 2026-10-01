---
name: lookup_es_verifactu_supplier
summary: Find one ES Verifactu supplier in Invopop by its tax ID and report its registration state and history
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
    note: asks for the NIF, then whether to read Fresha's side too
  - args: "B85905495"
    note: with or without ES in front, however it is spaced
  - args: "--db ESB85905495"
    note: both sides — Fresha's Verifactu plugin and Invopop's entries
  - args: "--json B85905495"
    note: for a script; never prompts
related: [check_invopop_suppliers, lookup_es_verifactu_invoice]
---

# lookup_es_verifactu_supplier

Answers one question: *is this supplier registered for Verifactu, and if not,
why?* Give it a NIF and it finds the supplier's entries in Invopop's ES workspace,
says what state the newest one is in, and lists the older ones as the history
behind it.

`check_invopop_suppliers` answers the same question for every supplier at once;
this is the one-supplier version, for when someone hands you a tax ID.

## What it does

1. **Whose workspace** — `GET /access/v1/workspace` names the workspace the token
   opens, and warns when its country is not ES: an IT token answers "not found"
   about every Spanish supplier.
2. **Find it** — a free-text search, `GET /silo/v1/search?q=…&folder=suppliers`,
   once for each way of writing the NIF (as typed, without ES, with ES), because
   the index matches what was stored. Hits that came back without their document
   are fetched again by id, since the tax ID lives in the document.
3. **Fall back to the folder** — the search index lags, sometimes by half an hour.
   When it finds nothing, the `suppliers` folder itself is read page by page with
   `GET /silo/v1/entries` (up to `--scan`, default 2000). That answer is
   authoritative, only slower, which is why it is the fallback.
4. **Match exactly** — on letters and digits alone, with or without ES in front:
   `ESB85905495`, `B85905495` and `B-8590549 5` are one NIF, a suffix of it is
   not. A NIF's own leading letter (`B…`, `Y…`) is never taken for a country.
5. **Report newest first** — each entry's state, bucketed the way
   `check_invopop_suppliers` buckets it (faults make an entry an error whatever
   its state says), with its entry id, key, faults and links. The newest entry is
   the answer; an older failure followed by a success is history, and is said to
   be.

## The Fresha side

`--db` (asked for on a terminal) reads Fresha's own record through the Metabase
CLI: `mb query` against **Snowflake Postgres**, database `87`, for the
`PUBLIC_ACCOUNT_CONFIGURATION_PLUGINS` rows with integration `verifactu` whose
`PARENT_NUMBER` — or whose configuration's `TAX_ID` or `VAT_NUMBER` — is this NIF,
normalised the same way (the column is stored as typed, lower case included). That
gives the plugin id, its account configuration, the plugin and third-party
statuses, whether it is the default plugin, and whether the configuration was
deleted or disabled.

A plugin in Fresha with nothing in the ES workspace means the registration never
reached Invopop. A missing or logged-out `mb` is reported and stepped over.

## Safety

Read-only, structurally: GETs only, no other HTTP verb anywhere in the file.
`grep -nwE "method|POST|PUT|PATCH|DELETE" lookup_es_verifactu_supplier.js` is the
test (whole words, so the `DELETED_AT` columns it reads do not count). There is nothing to dry-run and nothing to confirm.

## Prereqs

- Node ≥ 20 on PATH (built-in `fetch`; no dependencies).
- `INVOPOP_API_TOKEN` — the token for the **ES Verifactu** workspace, the same one
  `check_invopop_suppliers` and `lookup_es_verifactu_invoice` read. `ops run` asks
  for it once and saves it (`ops help credentials`); run directly, it prompts with
  the echo off.
- For `--db` only: the Metabase CLI (`mb`), logged in with `mb auth login`.
- No VPN and no houston.

## Output

- Fresha's plugin rows (with `--db`), then the supplier's Invopop entries, on
  stdout; warnings on stderr.
- `--json` emits `{tax_id, workspace, source, status, count, entries[], fresha}`
  and never prompts. `status` is the newest entry's bucket.
- Exit 0 when the supplier was found and its newest entry is not an error, 1 when
  nothing matched or the newest entry is an error, 2 when the call was wrong or the
  token was refused. A registration still processing is exit 0.
