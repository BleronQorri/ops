# fix_credit_note_references

**Env: production (writes). Runbook in progress — there is no script in this directory yet.**

Phase 2 of the B2B credit note work. Phase 1 ([b2b_credit_notes](../b2b_credit_notes/),
shipped in `bce292f`) answered *which invoice does each credit note credit*. Phase 2 is
meant to put that reference onto the documents so ZATCA will accept them.

**Status: BLOCKED on an `app-accounting-documents` code change. Nothing has been written
to production.** Read the next section before doing anything.

---

## ⛔ The blocker — patching the payload alone does nothing

All 34 rejected B2B credit notes carry exactly one ZATCA error and no other:

```
BR-KSA-56 — "For Credit Notes (381) and Debit Notes (383),
             the Billing Reference ID (BT-25) is mandatory."
XML:BillingReference
XML:cac:BillingReference/cac:InvoiceDocumentReference/cbc:ID
```

The obvious fix is to set `previous_receipt_number` in the document's `payload_base64`.
**That will not work**, and it took a wrong turn to find out why.

Credit notes route by `financial_relationship_type`
(`comarch/comarch_send_documents.ex:91-100`):

```elixir
:credit_note ->
  case billing_document.financial_relationship_type do
    :b2c -> RefundXMLBuilder.build(…)         # HAS maybe_build_reference/1
    :b2b -> B2BCreditNoteXMLBuilder.build(…)  # has NOTHING
  end
```

The two builders are near-identical, and the b2b one is missing one line:

```elixir
# refund_xml_builder.ex — b2c, InvoiceSubtype 0200000
element("InvoiceType", "381"),
element("InvoiceSubtype", "0200000"),
element("InvoiceCurrency", …), element("TaxCurrency", …),
maybe_build_reference(payload),                    # <-- PRESENT
element("BusinessProcessType", "reporting:1.0"),
element("CreditDebitNoteReason", "Refund of goods or services")
]
|> Enum.filter(&(&1 != nil))                       # <-- absorbs a nil

# b2b_credit_note_xml_builder.ex — b2b, InvoiceSubtype 0100000
element("InvoiceType", "381"),
element("InvoiceSubtype", "0100000"),
element("InvoiceCurrency", …), element("TaxCurrency", …),
                                                   # <-- MISSING
element("BusinessProcessType", "reporting:1.0"),
element("CreditDebitNoteReason", "Refund of goods or services")
]
                                                   # <-- and no nil filter
```

`grep -n "previous_receipt_number\|Reference\|PrecedingInvoiceReference\|InvoiceReferenceNumber"`
over all 461 lines of `b2b_credit_note_xml_builder.ex` returns **zero hits**. The builder
cannot emit a billing reference at any value of any field.

**So every B2B credit note has always been unsendable.** That matches the data: 34 of 34
rejected, one error code, no exceptions. It is not a backfill artefact.

### Why b2c credit notes are fine

They go through `RefundXMLBuilder` (subtype `0200000`, *simplified*), and ZATCA does not
enforce BT-25 on simplified invoices. Verified: `CN/1119` (`accounting_documents.id`
4838124) is `approved` / `sent` with `previous_receipt_number: nil` and
`financial_relationship_type: :b2c`.

### Comarch's own spec agrees

`ECODCoreInvoiceKSAXML-1.pdf` (XML Core Invoice KSA, COMARCH EDI, 2021-11-26), page 1:

```
<Reference>                                            C¹
  <ContractReferenceNumber>…</>                BT-12    O
  <BuyerOrderNumber>…</>                       BT-13    O
  <PrecedingInvoiceReference>                  BG-3   C[n]¹
    <InvoiceReferenceNumber>TOSL109</>         BT-25    M    X()
  </PrecedingInvoiceReference>
</Reference>
```

Footnote 1: **"Section is mandatory for InvoiceType=381, 383. For InvoiceType=388
shouldn't exist."**

So `<Reference>` is mandatory for credit notes per the vendor schema, and we emit
`InvoiceType 381` without it. Note `PrecedingInvoiceReference` is `C[n]` — **repeatable**,
so one credit note may cite several invoices.

Element order in the spec is `… InvoiceCurrency, TaxCurrency, Reference, Notes,
BusinessProcessType, CreditDebitNoteReason`. `RefundXMLBuilder` already places it
correctly; the b2b builder has the same order minus that line, so inserting it in the same
position is schema-correct.

## The required code change

In `app-accounting-documents`,
`apps/accounting_documents/lib/accounting_documents/einvoicing/comarch/builders/b2b_credit_note_xml_builder.ex`,
`build_invoice_header/2`: add `maybe_build_reference(payload)` between `TaxCurrency` and
`BusinessProcessType`, plus the two clauses copied from `refund_xml_builder.ex:89-103`.

**One open decision.** The b2b builder has no `Enum.filter(&(&1 != nil))`, so a
`maybe_build_reference` that returns `nil` would leave a literal `nil` in the element list.
Two options:

- add the filter, mirroring b2c — emits an invalid document when the field is unset
- return `{:error, :missing_preceding_invoice_reference}` — fails fast, matches the spec's `M`

The spec says mandatory, so failing fast is arguably right. Not decided.

**Second open decision, and it determines whether the data work below is needed at all:**
when the fix ships, does the builder read `previous_receipt_number` from the payload (as
b2c does), or resolve the invoice at send time? If the latter, no payload patching is
required.

## ⚠ Do not "fix" this by flipping to b2c

Setting `financial_relationship_type: :b2c` in the payload *would* route these to
`RefundXMLBuilder` and produce a valid BT-25 today with no code change. **Don't.** It also
flips `InvoiceSubtype` from `0100000` (tax invoice) to `0200000` (simplified), which per
the spec changes buyer-detail fields from mandatory to optional. That is misreporting a
B2B transaction as simplified to a tax authority.

---

## Verified mechanics (all still valid, reusable)

| Fact | How it was verified |
|---|---|
| `payload_base64` = `Base.encode64(:erlang.term_to_binary(%BillingDocument{}))` | every value starts `g3QA` (ETF version byte `0x83`) |
| A single-field patch round-trips exactly **without the app modules loaded** | 9/9 local assertions: `Decimal` structs, nested `Item`/`TaxItem`, atoms all survive; only the target field changes |
| Byte length and md5 **change** on re-encode | 1052 → 1064 in the test. Map-key order isn't preserved. **Never** use length/md5 as a correctness check — decode and compare terms |
| **No line-item rows to clean up** | `einvoicing_accounting_document_line_items` = 0 on every sampled doc. The IT trap in [edit_document_payload](../edit_document_payload/) §6 is `["IT"]`-only |
| Trackers are retry-eligible as they stand | all 34 at `review_status = rejected`; the filter wants `failed_to_send` **or** `rejected` |
| `FORCE=true` does **not** bypass eligibility | `retry_sending_failed_accounting_documents_action.ex:43-52` |

Local Elixir needs the version pinned outside a `.tool-versions` dir:

```bash
ASDF_ELIXIR_VERSION=1.17.1-otp-26 ASDF_ERLANG_VERSION=26.2.1 elixir script.exs
```

## The matching algorithm — reuse, don't reinvent

`previous_receipt_number` must be set to the matched invoice's
`accounting_documents.receipt_number`. The match comes from `pickInvoice` in
[b2b_credit_notes](../b2b_credit_notes/b2b_credit_notes.js), unchanged:

1. Validate the id: `document_type = 'credit_note'` **and** `einvoice_reference IS NOT NULL`
2. Resolve to shedul via `einvoice_reference` → provider, billing period, and the credit
   note's value = `abs(sum(provider_invoice_items.fee))` — **never** `provider_invoices.total`
3. Candidates = that provider's invoices with `einvoice_reference IS NOT NULL`, any period
4. Keep `invoice.total >= credit note value`
5. Rank: own period first → then created at or before the credit note → then most recent
6. Take the top

Confirmed on two documents that AD `receipt_number` is byte-identical to shedul
`invoice_reference` for invoices — but read it from `accounting_documents` rather than
trusting the equality.

---

## Where we got to

Pilot document **`4836650` (CN/1107)**, chosen as the least entangled: most recent, smallest
value (16.18), own-period match.

| Step | State |
|---|---|
| 1. Read + back up payload, read tracker | ✅ done — read-only |
| 2. Resolve invoice | ✅ done — `INV/21396`, `provider_invoice_id` 4284689, July 2026, `Period: same`, 5527.62 vs 16.18 |
| 3. Decode and inspect | ✅ done — local |
| 4. Patch + re-encode + assertions | ⬜ not started |
| 5. `update_accounting_document_payload` | ⬜ not started — **first write** |
| 6. Force retry | ⛔ **parked** — pointless until the builder ships, and it burns the eligible tracker state (moves it to `corrected`, which is *not* eligible, so 34 trackers would need flipping back) |
| 7. Verify | ⬜ |

**Backup:** `/tmp/cn-payload-backup/4836650.b64` — 3324 bytes, md5
`a5ba7ffa1da5945a082ae2d3ca1f99d2`. ⚠ `/tmp` is cleared on reboot. Nothing was written, so
no rollback is currently needed, but move backups somewhere durable before step 5.

### What step 3 showed on 4836650

```
kind                    : :credit_note
financial_relationship  : :b2b        <- routes to the builder that can't emit <Reference>
receipt_number          : "CN/1107"
previous_receipt_number : nil
invoice_date            : "2026-07-31T00:00:00Z"
total_net / total_gross : -14.07 / -16.18      (negative; the matcher compares magnitudes)
issuer                  : :fresha    tax 311268874200003
issuee                  : :provider  tax 311838689200003  crn 7037685448
items                   : 1  — "Blast email (%{campaign_messages_count} messages) refund"  -16.18
```

The issuee has a full KSA tax number and CRN, which is *why* the adapter classified it
`:b2b` — so this really is a standard invoice and BT-25 really is mandatory.

## Scope — the 34 credit notes

**The source of truth is this sheet, not this file:**

```
https://docs.google.com/spreadsheets/d/1ziLw2i6ISmye2DZV0dSThf0jscP9lpngPow5jZDwfuU
gid 1304794537
```

Columns: `id | provider_id | receipt_number | document_type | upload_status | review_status | created_at`.
It is a **scope list** — which credit notes are in play. It carries no invoice column, so
the credit note → invoice mapping still comes from the matcher (see above), not the sheet.

When the phase-2 script exists, the sheet id belongs in it as a constant:

```elixir
# Source of truth for which credit notes are in scope.
# https://docs.google.com/spreadsheets/d/1ziLw2i6ISmye2DZV0dSThf0jscP9lpngPow5jZDwfuU (gid 1304794537)
@scope_sheet_id "1ziLw2i6ISmye2DZV0dSThf0jscP9lpngPow5jZDwfuU"
```

Deliberately **not** hardcoded into [b2b_credit_notes](../b2b_credit_notes/) — that is a
general tool that takes any ids; this is one operation's scope.

⚠ **The sheet's `upload_status` / `review_status` are a snapshot** from when it was exported
(July 28 / Aug 2 2026). Once these documents start being re-driven the sheet will still say
`rejected` for ones that have moved on. Use the sheet for *which 34*; use a fresh
`b2b_credit_notes.js` run for *where they are now*.

Reading it needs the claude.ai Google Drive connector with Drive scopes. It initially failed
every call with `Request had insufficient authentication scopes` — fixed by reconnecting the
connector via `/mcp`. Note Drive exposes no `authenticate` tool (unlike Gmail / Calendar /
Zapier), so a scope problem there cannot be fixed from inside a session.

The ids, verified identical to the sheet (34 in each, zero diff either way):

```
4762874 4762876 4762877 4762878 4762879 4762884 4762887 4762891 4762892 4762893
4762895 4762906 4762909 4762910 4762917 4762918 4762922 4762924 4762930 4762934
4762938 4762939 4762945 4762952 4762958 4762961 4762965 4762972 4762973 4762977
4762980 4762988 4836650 4762882
```

All `account_configuration_id` 33 (SA / SAR), all `rejected`/`rejected`, all
`BR-KSA-56`. They are the `Backfills::ProcessCreditNotes` cohort re-emitted in July 2026.

**Held out of any first batch:** `4762934` (CN/1044), `4762909` (CN/1018), `4762877`
(CN/995) — all provider 2582590, all worth exactly 2000.00, all resolving to the **same**
invoice `INV/13408` (3764.79). That's 6000.00 of credits against one 3764.79 invoice. The
matcher is behaving as specified, but three credit notes citing one invoice as BT-25 may be
refused for a fresh reason; learn that from a clean batch.

## Next session

1. Decide the two open questions above (nil handling; payload vs send-time resolution).
2. Draft the `b2b_credit_note_xml_builder.ex` change + test in `app-accounting-documents`.
3. Only then do the data work — steps 4, 5, then 6.
4. Verification is phase 1's own matrix re-run: `CN status` should move from
   `rejected (rejected/rejected)` to `approved (approved/sent)`.
5. This directory isn't in the root [AGENTS.md](../../../AGENTS.md) tables yet — add it when
   it has a script, or leave it as a runbook like [edit_document_payload](../edit_document_payload/).

Noticed in passing, deliberately not chased: the line description reported to ZATCA
contains a literal uninterpolated `%{campaign_messages_count}`.

## Prereqs

- VPN up, `houston` authenticated. Reads use `fresha-production-developer`.
- Local Elixir for the decode/encode (pin the asdf version as above).
- Read [edit_document_payload/AGENTS.md](../edit_document_payload/AGENTS.md) first — it is
  the general runbook for payload surgery and covers the write task, rollback and the
  retry semantics.
