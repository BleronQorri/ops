---
name: lookup_sa_zatca_document
summary: Find one KSA invoice or credit note by its number and report where it is on its way to ZATCA, and why
domain: e-invoicing
country: SA
integration: zatca
integrator: comarch
env: production
access: read-only
tier: read-only
lang: js
examples:
  - args: ""
    note: asks for the receipt number, then for a VAT number or CRN you can skip
  - args: "IRN031174"
    note: the number printed on the document; one row per supplier that issued it
  - args: "--tax-id 302077120700003 IRN031174"
    note: one supplier's document, reported in full — the VAT number or the CRN
  - args: "--config 443 IRN031174"
    note: narrow it to one account configuration, by id or plugin id
  - args: "--document 5481081"
    note: one accounting document by its id
  - args: "--web-doc 624697613"
    note: the document Comarch knows by this WebDocId
  - args: "--json IRN031174"
    note: for a script; never prompts
related: [lookup_invopop_document, match_credit_notes_to_invoices, force_retry_invoices]
---

# lookup_sa_zatca_document

Answers one question: *what happened to this KSA document?* Give it the number
printed on a Saudi invoice or credit note (`IRN…`) and it says whether ZATCA
approved it, whether Comarch refused it before ZATCA ever saw it, or whether it is
still on its way — and, when it went wrong, what Comarch said.

The KSA sibling of `lookup_invopop_document`, with one difference that shapes it:
it never calls Comarch. Everything Comarch says about a document is already written
down in Fresha's own tables, so this reads those, through the Metabase CLI.

## What it does

1. **Find it** — `mb query` against **Snowflake Postgres** (database `87`), the
   Debezium replica of `accounting_documents`. The documents whose receipt number
   is exactly the one asked for (case aside), joined to their account
   configuration, their plugin and their latest tracker. `--document` and
   `--web-doc` look one up by its id or by Comarch's WebDocId instead.
2. **Whose document** — a receipt number is only unique within a supplier, and
   `IRN014431` has been issued fifty-two times. On a terminal it asks for a VAT
   number or CRN and an empty answer means "every supplier"; `--tax-id` skips the
   question. Matching is exact on the letters and digits alone, with or without
   `SA` in front: `302077120700003` and `SA 3020 7712 0700 003` are one
   registration, a suffix is not. A KSA supplier is known by its VAT number (15
   digits) and its CRN (10); either works.

   A number that only exists outside KSA is not reported, but it is counted and
   the countries named — so an IT receipt number typed here says so instead of
   looking like a gap.
3. **Read the rest** — one more query for just those documents: every tracker,
   every error Comarch returned, every ZATCA compliance record and the document's
   log.
4. **Say where it is** — in the words the service itself uses to decide
   (`EInvoiceStatus.from_tracker` in app-accounting-documents): ZATCA's verdict wins
   whenever it has given one, then an upload Comarch refused outright, and anything
   else is still on its way.

| mark | tracker | meaning |
|---|---|---|
| `✓ ok` | review `approved` / `approved_with_warnings` | ZATCA has it; the QR should be stored |
| `… pending` | upload `not_started`, `ready_to_send`, `sending_in_progress`, `failed_to_send` (retried automatically), `sent` awaiting review; review `corrected` (a retry supersedes it) | still on its way; not a problem yet |
| `✗ error` | review `rejected` / `failed`, or upload `rejected` | it did not land — the error says why |
| `⊘ voided` | document deleted | removed on purpose |
| `? unknown` | no tracker | never queued to send |

Up to three documents get a report each; more than that become one row each, the
ones in trouble first, since a report per supplier for fifty suppliers is a wall.
`--document` or `--tax-id` then gets the full report of the one you want.

## Where Comarch's side lives

| Comarch says | Fresha keeps it in |
|---|---|
| `ControlNumber` a document was sent under | the tracker's id |
| `WebDocId` | `e_invoice_trackers.web_doc_id` |
| `/api/status/error` — `ErrorDescription`, `ErrorDetails[]` | `accounting_document_error_logs.raw_error`, verbatim |
| the APERAK ZATCA sent back — the QR | `e_invoice_compliance_records` |

That is why no Comarch token is asked for. Asking Comarch live would mean
production credentials and a `/api/auth` call on the service's own login, and a
second session there is not a risk worth a lookup. The error details come in two
shapes and both are printed: a mapping failure lists business rules (`BR-16 An
Invoice shall have at least one Invoice line`), and `Document already sent.` names
the original it collided with. An error log with no description is printed as
"Comarch gave no reason", which is what it is.

An approved document with no compliance record is flagged: ZATCA's answer came
back but was not matched to the document, so the customer's copy has no QR. The
unmatched ones sit in `e_invoice_unmatched_compliance_records`, which the replica
does not carry.

The history folds the log's noise away: every status change is written twice
(`…_updated`, then `…_confirmed`), and a document Comarch keeps re-reporting
repeats that pair every few minutes for hours. A confirmation joins the update it
confirms and a run of one event is one line with its count and its last time.

## Safety

Read-only, structurally: two `SELECT`s through `mb query`, no HTTP client, no
houston, nothing to dry-run and nothing to confirm.
`grep -nE "fetch\(|spawnSync\(" lookup_sa_zatca_document.js` is the test: one
`spawnSync`, and it runs `mb query`.

## Prereqs

- Node ≥ 20 on PATH (no dependencies).
- The Metabase CLI on PATH (`mb`), logged in once with `mb auth login` (`mb auth
  status` to check). It is the only source, so without it the run is exit 2.
- No VPN, no houston, no token.

## Output

- A report per document on stdout, or a table of them when there are more than
  three; the "reading…" line on stderr.
- The replica trails production by a few minutes. When anything shown is still on
  its way it says so, so a verdict from a minute ago is not mistaken for one that
  never came.
- `--json` emits `{receipt, document_id, web_doc_id, tax_id, config, count,
  other_countries, documents[]}` and never prompts; each document carries its
  supplier, latest tracker, every tracker, errors, compliance records and history.
- Exit 0 when something was found and nothing shown is in an error state, 1 when
  nothing matched or something shown is in one, 2 when the call was wrong or the
  Metabase CLI could not answer.
