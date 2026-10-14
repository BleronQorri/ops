---
name: send_zatca_scenarios_to_invopop
summary: Send made-up KSA invoices and credit notes to ZATCA through an Invopop sandbox and report which are accepted
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
    note: asks for the scenarios and whether to dry run (and the token, when it is unset)
  - args: "all --dry-run true"
    note: build every scenario's GOBL and print it, send nothing
  - args: "all --dry-run false"
    note: send every scenario, after a typed yes, and table the verdicts
  - args: "b2b_invoice_rounding b2b_invoice_zero_line --dry-run false --show-gobl"
    note: the two arithmetic edge cases only, with the GOBL that was sent
related: [lookup_invopop_document, lookup_invopop_supplier, deregister_invopop_suppliers]
---
# send_zatca_scenarios_to_invopop

Answers one question: *would ZATCA accept the invoices Fresha issues, sent through
Invopop?* It builds KSA invoices and credit notes on the fly, sends them to ZATCA
through the Invopop **sandbox** workspace, and reports per document whether it was
accepted, and ZATCA's own messages when it was not.

The documents are built the way `app-accounting-documents` builds them: the script
is a line-for-line port of the four ZATCA GOBL builders and the party builder in
`einvoicing/invopop/sa/zatca/`, and it sends them the way
`Zatca.Invoice.dispatch_submission` does. Rebuilt from their own inputs, all 90
production GOBLs sampled from the shadow log (every document type) came out
identical. When a builder changes there, change it here.

## Scenarios

Taken from the September 2026 ZATCA shadow log (1,211 documents): every document
was an invoice or a credit note, standard (B2B, the buyer has a CRN) or simplified
(B2C), with 1 to 12 lines, each line standard-rated at 15%, quantity 1, no
discounts. Two line shapes are the likeliest to trip ZATCA's arithmetic, so each
gets a scenario of its own: a 0.00 line (111 in the log) and VAT-inclusive prices
whose net is not a whole number of halalas (395 in the log). The buyers are made
up; nothing from the log is copied. `--help` lists them.

A credit note cites the invoice numbered before it in the same run, so `all` sends
them in order. Numbers are `INV/T<run><n>` and `CN/T<run><n>`, new on every run.

## What it does

1. **Asks** for the scenarios and whether to dry run, unless the flags say.
2. **Proves it is a sandbox**, two ways, either of which stops the run before
   anything is sent:
   - `GET /access/v1/workspace` must answer `sandbox: true`. The token decides the
     workspace, so a production token is refused here whatever else is set.
   - `GET /transform/v1/workflows/{id}` must find the script's one workflow,
     `88e0b9b3-290a-4c02-98c0-47d99e637ac3` in `fresha_sandbox_zatca`, in this
     workspace. It is a copy of the ZATCA invoice workflow made for this test
     without a webhook step, so no Fresha environment hears about these
     documents. It is fixed in the script, not a flag.
3. **Picks the supplier** from the workspace's `suppliers` folder: only a
   `registered` one, since ZATCA takes documents only from a registered supplier.
   One registered supplier is taken; several are offered in a picker.
4. **Builds** each document's GOBL from the scenario and the supplier.
5. **Dry run** (the default) prints the GOBL and stops.
6. **Sends**, after a typed `yes`: a draft Silo entry in `invoices`, keyed
   `zatca-scenario-<run>-<n>`, then a Transform job on that workflow, waiting
   for the verdict (`--wait`, default 120 s).
7. **Reports** accepted, rejected (with the faults and failed steps) or no verdict
   in time, one line per document.

## Safety

Sandbox only, by the two checks above. Nothing is written locally: no database,
no files. What remains afterwards is the Silo entries and Transform jobs in the
sandbox workspace. In ZATCA's developer mode, cleared documents count for nothing.

## Prereqs

- `INVOPOP_SA_ZATCA_SANDBOX_API_TOKEN`: the API key of the SA ZATCA sandbox
  workspace (`ACCOUNTING_DOCUMENTS_INVOPOP_SA_ZATCA_API_KEY_SANDBOX` in
  app-accounting-documents' secrets). `ops run` asks for it once.
- A supplier registered with ZATCA in that workspace. Without one the run stops
  with exit 1 before building anything.
- Node ≥ 20. No VPN, no houston.

## Output

A verdict table on stdout, or one JSON object per document with `--json`.
Exit 0 when every document sent was accepted (or the dry run built them all), 1
when at least one was rejected or had no verdict in time, 2 when the call was wrong,
the token was refused or the workspace is not a sandbox.
