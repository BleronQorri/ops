---
name: audit_invopop_parity_with_comarch
summary: Replay real KSA B2B invoices through an Invopop sandbox with Comarch's numbers and check ZATCA gets the same
domain: e-invoicing
country: SA
integration: zatca
integrator: invopop
env: staging
access: write
tier: staging
lang: js
secrets: [INVOPOP_SA_ZATCA_SANDBOX_API_TOKEN]
asks: true
examples:
  - args: ""
    note: asks for the CSV and whether to dry run (and the token, when it is unset)
  - args: "--csv ~/Desktop/ksa-b2b-invopop-replay/issue_einvoice_commands.csv --limit 5 --dry-run true"
    note: the first five standard invoices, built and listed, nothing sent
  - args: "--csv ~/Desktop/ksa-b2b-invopop-replay/issue_einvoice_commands.csv --limit 20 --dry-run false"
    note: send twenty, download what Invopop sent ZATCA, and table ✅ / 🔴
  - args: "--csv ~/Desktop/ksa-b2b-invopop-replay/issue_einvoice_commands.csv 9636 --dry-run false --show"
    note: one invoice by its receipt number, with its Comarch XML and GOBL
reports: [invopop-parity-*]
related: [send_zatca_scenarios_to_invopop, lookup_sa_zatca_document, ksa_fresha_vendor_switch]
---
# audit_invopop_parity_with_comarch

Answers one question before Fresha's Saudi entity moves from Comarch to Invopop:
*does ZATCA get the same numbers from Invopop that it gets from Comarch today?* It
takes real invoices from an IssueEInvoice command export, builds each one twice
from the same `BillingDocument` — the way Comarch's `B2BInvoiceXMLBuilder` does,
and the way `InvoiceGoblBuilder` does with the `bypass` tag (#2225) — sends the
GOBL to an Invopop **sandbox** exactly as production does, downloads what Invopop
sent ZATCA, and compares it with the Comarch invoice field by field: ✅ at parity,
🔴 with the fields that differ.

## What it does

1. **Reads the CSV**, one row per invoice line, grouped by `reference.value` into
   the `BillingDocument` the builders take. Only standard (B2B) invoices go
   further: the buyer must pass `KSAB2BReportability.reportable_as_b2b?` (CRN,
   tax number, district and building number present and well formed). A buyer
   that fails it would be sent as a simplified invoice, and credit notes cannot be
   tied to the invoice they credit from the export, so both are left out.
2. **Builds the Comarch invoice**: a port of `B2BInvoiceXMLBuilder`,
   `InvoiceBuilderBlocks` and `InvoiceCalculationHelper`. The line net, VAT and
   gross are the stored ones, the unit net price is `unit_gross / (1 + rate/100)`
   to six places, the document VAT is gross less net, and the tax summary groups
   by rate.
3. **Builds the GOBL** as `InvoiceGoblBuilder` and `TotalsGoblBuilder` do on main
   since #2225: tagged `bypass` so GOBL calculates nothing, each line priced net to
   six places, and the totals summed from the lines (a line's VAT is its gross less
   its net), down to how Elixir's `Decimal` prints each amount. Built from all
   3,352 standard invoices in `issue_einvoice_commands.csv`, the port and main's
   own builder gave identical GOBL (the `uuid` aside). When a builder changes
   there, change it here.
4. **Proves it is a sandbox**, the same two checks as
   `send_zatca_scenarios_to_invopop`: the workspace answers `sandbox: true`, and
   the webhook-less workflow `88e0b9b3-290a-4c02-98c0-47d99e637ac3` exists in it.
5. **Sends** each invoice after a typed `yes`, the way `Zatca.Invoice` does: a
   draft Silo entry in `invoices`, then a Transform job with the same key on the
   webhook-less workflow, issued as the sandbox's registered supplier and
   renumbered `<receipt>-T<run>`.
6. **Waits** for the job, then `--settle` seconds more, and **downloads** the Silo
   entry and its `invoice.xml` attachment: the UBL Invopop sent ZATCA.
7. **Compares** what Comarch is sent against:
   - the UBL: the type and subtype, date, buyer name and CRN, the document totals,
     each tax subtotal, and each line's quantity, net, VAT, gross, unit price,
     category and rate;
   - the `zatca-qr` stamp: total with VAT and VAT total;
   - the Silo GOBL totals.

   Amounts compare as numbers, so `15.0` and `15.00` agree.

The seller is the one field never compared: a sandbox can only issue as its own
registered supplier. A known difference can be left out of the verdict with
`--ignore`, e.g. `--ignore InvoiceUnitNetPrice`.

## Safety

Sandbox only, by the two checks above; a production token is refused before
anything is built. A dry run (the default) reads the CSV and the workspace and
sends nothing. A send writes Silo entries and Transform jobs to the sandbox
workspace, keyed `zatca-comarch-parity-<run>-<n>`. In ZATCA's developer mode,
cleared documents count for nothing.

## Prereqs

- `INVOPOP_SA_ZATCA_SANDBOX_API_TOKEN`: the API key of the SA ZATCA sandbox
  workspace. `ops run` asks for it once.
- A supplier registered with ZATCA in that workspace.
- An IssueEInvoice command export with the `einvoice_items.*` columns, such as
  `issue_einvoice_commands.csv`.
- Node ≥ 20. No VPN, no houston.

## Output

A dry run lists the invoices it built, one per line. A send writes
`./invopop-parity-<run>/`:
- per invoice, the Comarch XML, the GOBL sent, the Silo entry and the UBL received;
- `summary.csv`, one row per differing field.

On stdout, one ✅ or 🔴 per invoice with its differing fields, then a count of
each differing field across the run. `--json` gives one object per invoice
instead.

Exit 0 when every invoice is at parity (or the dry run built them all), 1 when at
least one is not, 2 when the call was wrong, the token was refused or the
workspace is not a sandbox.
