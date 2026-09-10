---
name: edit_document_payload
summary: "Runbook: hand-edit an accounting document's payload_base64 on a pod and re-drive the send"
env: production
access: write
tier: prod-write
status: runbook
related: [fix_invoice_payloads, b2b_credit_notes]
---
# edit_document_payload

How to edit an accounting document's stored `payload_base64` and re-drive the
send. Written against the worked example of document **4687595** (Italy / Invopop
Smart Receipts, rejected because of a zero-price line item), but the mechanics
apply to any payload surgery.

Every code reference is `app-accounting-documents` at `src/`, verified against
`main` at `f54aed9e` (2026-08-03).

---

## 1. What `payload_base64` actually is

```
Base.encode64(:erlang.term_to_binary(%AccountingDocuments.Structs.BillingDocument{}))
```

Erlang External Term Format — that's why every value starts with `g3` (`0x83`,
the ETF version byte). Written once, at document creation, by
`create_accounting_document_and_tracker_action.ex:235`:

```elixir
defp convert_payload_to_base64(payload) do
  payload |> :erlang.term_to_binary() |> Base.encode64()
end
```

It is **not** the `Events.Sales.SaleCreated.V1.Payload` that
`UpdateAccountingDocumentPayloadTask`'s `@moduledoc` claims — that docstring is
stale. It's a `BillingDocument`.

### The struct

`apps/accounting_documents/lib/accounting_documents/structs/billing_document.ex`

| field | type | notes |
|-------|------|-------|
| `reference` | `String.t()` | the sale id, as a **string** |
| `receipt_number` | `String.t() \| nil` | overwritten from the DB column on retry |
| `previous_receipt_number` | `String.t() \| nil` | |
| `original_sale_id` | `non_neg_integer() \| nil` | set on refunds; drives credit-note matching |
| `issuer` / `issuee` | `InvoiceParty` \| `ReducedInvoiceParty` \| nil | `party_type` is `:provider` or `:fresha` |
| `items` | `[Item.t()]` | the sale lines |
| `service_charges` | `[Item.t()]` | reported as lines by Smart Receipts only |
| `total_net` / `total_gross` | `Decimal.t()` | document totals |
| `service_charges_net` / `_gross` | `Decimal.t() \| nil` | |
| `kind` | `:invoice \| :credit_note` | |
| `financial_relationship_type` | `:b2b \| :b2c` | |
| `invoice_date` | `String.t()` | ISO8601 with offset |
| `location_id` | `non_neg_integer() \| nil` | |

`Item` carries `name`, `quantity`, `item_type`, `unit_price`, `unit_gross`,
`total_net`, `total_gross`, `tax_items`, `line_id`, `line_item_id`, `discounts`,
`line_item_type` (`:line_item \| :service_charge`).

`unit_price` is the **pre-discount list** gross unit price; `unit_gross` is the
**charged** gross unit price. Equal when there's no discount — the GOBL builder
derives the discount from the gap between them.

### Canonical line order — this matters

`BillingDocument.all_lines/1` is `(items || []) ++ (service_charges || [])`. That
fixed order is load-bearing: the GOBL builder numbers lines `i` from it
(`invoice_gobl_builder.ex:35-37`), and IT line-item persistence uses the same
order, so GOBL `i` == stored `EInvoicingAccountingDocumentLineItem.index`. Anything
you do to `items` shifts every service-charge index after it.

### Round-tripping is safe

`binary_to_term` → `term_to_binary` gives a **semantically identical** term
(`==` holds). The bytes differ — map-key ordering is not preserved — but nothing
reads the bytes; every consumer goes through `binary_to_term`. Verified on 4687595:
2274 bytes in, 2274 bytes out, first difference at offset 7, terms compare equal.

So: **do not** try to make the re-encoded base64 byte-identical to the original.
It won't be, and that's fine.

---

## 2. Read the payload

```bash
houston psql production accounting_documents -- -t -A \
  -c "SELECT payload_base64 FROM accounting_documents WHERE id = 4687595;" \
  2>/dev/null | tr -d '[:space:]' > 4687595.b64

wc -c 4687595.b64
```

- `-t -A` — tuples only, unaligned, so you get the bare value.
- `2>/dev/null` — drops Houston's `INFO houston: Connecting to …` banner, which
  goes to stderr.
- `tr -d '[:space:]'` — psql appends a newline; a stray `\n` makes
  `Base.decode64!/1` raise `ArgumentError`.

Pull the surrounding state at the same time — you need the tracker status to know
whether the resend will even be eligible:

```bash
houston psql production accounting_documents -- -x -c "
SELECT ad.id, ad.document_type, ad.sale_id, ad.sale_id_64, ad.receipt_number,
       ad.einvoice_reference, ad.account_configuration_id,
       ad.account_configuration_plugin_id, ad.provider_id, ad.legal_entity_id,
       ad.latest_tracker_id, ad.deleted_at,
       t.review_status, t.upload_status, t.web_doc_id, t.invalidated_at,
       ac.country_code AS cfg_country,
       p.integrator, p.integration, p.plugin_status,
       p.third_party_integration_status, p.paused_sending_documents_at
FROM accounting_documents ad
JOIN e_invoice_trackers t ON t.id = ad.latest_tracker_id
JOIN account_configurations ac ON ac.id = ad.account_configuration_id
LEFT JOIN account_configuration_plugins p ON p.id = ad.account_configuration_plugin_id
WHERE ad.id = 4687595;"
```

**Gotcha — `sale_id` vs `sale_id_64`.** The DB has both columns and on newer rows
the int4 `sale_id` is NULL while the bigint `sale_id_64` holds the value. App code
is unaffected because the schema aliases it
(`schemas/accounting_document.ex:26`):

```elixir
field(:sale_id, :integer, source: :sale_id_64)
```

So `Repo.get_by(AccountingDocument, sale_id: …)` reads `sale_id_64`. Your **SQL**
must use `sale_id_64`; your **Elixir** uses `sale_id`. Getting this backwards makes
document lookups look broken when they aren't.

Also worth pulling — the persisted line items, because they don't come along for
the ride (see §6):

```bash
houston psql production accounting_documents -- -c "
SELECT id, index, line_id, line_item_id, line_item_type, external_reference_id
FROM einvoicing_accounting_document_line_items
WHERE accounting_document_id = 4687595 ORDER BY index;"
```

And the failure trail, such as it is:

```bash
houston psql production accounting_documents -- -c "
SELECT id, created_at, left(raw_error::text, 800)
FROM accounting_document_error_logs WHERE accounting_document_id = 4687595;"

houston psql production accounting_documents -- -c "
SELECT id, log_type, metadata, created_at
FROM accounting_documents_logs WHERE accounting_document_id = 4687595;"

houston psql production accounting_documents -- -c "
SELECT id, external_invoice_reference, created_at, deleted_at
FROM e_invoice_compliance_records WHERE accounting_document_id = 4687595;"
```

On 4687595 all three are empty — an Invopop rejection arrives by webhook and
leaves nothing but `review_status = rejected`. **The reason is only in Datadog**
(`/dd-logs`, service `accounting-documents`, env `production`). Don't infer the
cause from the DB.

---

## 3. Decode

The `accounting-documents` component exists in **staging only**; in production the
console component is `accounting-documents-web`.

```bash
houston console eng-orion accounting-documents
```

Then in `iex`, paste the base64:

```elixir
b64 = "g3QAAAARdwlyZWZlcmVuY2U..."          # full value from the .b64 file

doc = b64 |> Base.decode64!() |> :erlang.binary_to_term()

IO.puts(inspect(doc, pretty: true, limit: :infinity, printable_limit: :infinity, width: 100))
```

On the pod the modules are loaded, so this inspects as a real
`%AccountingDocuments.Structs.BillingDocument{}` with `%Decimal{}` values. The
app's own safe reader is there too, and is what production code uses
(`submission.ex:255`):

```elixir
doc = b64 |> Base.decode64!() |> Plug.Crypto.non_executable_binary_to_term()
```

`non_executable_binary_to_term/1` rejects anonymous functions and other
executable terms; raw `binary_to_term` on untrusted input is an RCE. This payload
is service-generated so either works, but prefer the safe one by habit.

**Locally is fine too**, and better for diffing — you get a scriptable, repeatable
transform instead of REPL state:

```bash
# needs asdf's elixir; run from a dir with a .tool-versions, or pin explicitly:
export ASDF_ELIXIR_VERSION=1.17.1-otp-26 ASDF_ERLANG_VERSION=26.2.1
```

```elixir
# decode.exs
doc =
  "4687595.b64"
  |> File.read!() |> String.trim()
  |> Base.decode64!() |> :erlang.binary_to_term()

IO.puts(inspect(doc, pretty: true, limit: :infinity, printable_limit: :infinity, width: 100))
```

Without the app in scope the structs inspect as plain maps with a `__struct__`
key (`%{__struct__: AccountingDocuments.Structs.BillingDocument, …}`) and
`Decimal`s show raw as `%{sign: 1, coef: 3279, exp: -2}` — read that as
`sign × coef × 10^exp`, so `32.79`. Noisier, but the term is identical and
`term_to_binary` re-encodes it correctly without the modules loaded.

### Worked example — 4687595

```elixir
%BillingDocument{
  reference: "542529976",              # sale id, as a string
  receipt_number: "INV013",
  kind: :invoice,
  financial_relationship_type: :b2c,
  invoice_date: "2026-07-22T13:40:11.875658+02:00",
  issuer: %ReducedInvoiceParty{id: 2875625, party_type: :provider},
  issuee: nil,
  location_id: 2974932,
  total_net: #Decimal<32.79>,
  total_gross: #Decimal<40.0>,
  service_charges: [],
  service_charges_net: #Decimal<0.0>,
  service_charges_gross: #Decimal<0.0>,
  previous_receipt_number: nil,
  original_sale_id: nil,
  items: [
    # [0] the free item
    %Item{name: "CONTROLLO MENSILE", line_id: 826971469, line_item_id: 28408886,
          quantity: 1, item_type: "ServicePricingLevel", line_item_type: :line_item,
          unit_price: #Decimal<0.0>, unit_gross: #Decimal<0.0>,
          total_net: #Decimal<0.0>, total_gross: #Decimal<0.0>, discounts: [],
          tax_items: [%TaxItem{name: "IVA", rate: #Decimal<22.0>, value: #Decimal<0.0>}]},
    # [1] the real item
    %Item{name: "COPERTURA GEL", line_id: 826971470, line_item_id: 28408605,
          quantity: 1, item_type: "ServicePricingLevel", line_item_type: :line_item,
          unit_price: #Decimal<40.0>, unit_gross: #Decimal<40.0>,
          total_net: #Decimal<32.79>, total_gross: #Decimal<40.0>, discounts: [],
          tax_items: [%TaxItem{name: "IVA", rate: #Decimal<22.0>, value: #Decimal<7.21>}]}
  ]
}
```

Note the document totals (`32.79` / `40.0`) already equal the second item alone —
the free item contributes nothing, so removing it needs **no totals fixup**. Check
this every time; it is not guaranteed.

Why this plausibly got rejected: the GOBL builder emits the free line as
`{"i": 1, "quantity": "1", "item": {"name": "CONTROLLO MENSILE", "price": "0.0", …},
"taxes": [{"cat": "VAT", "percent": "22.0%"}]}` — a zero-amount line carrying a
22% VAT percent, because `zero_rate?/1` only checks the *rate*, not the amount
(`invoice_gobl_builder.ex:106-118`). Treat that as a hypothesis until Datadog
confirms it.

---

## 4. Edit and re-encode

Match items on `line_item_id`, never on name or list position — it's the only
stable key, and it's what the refund path uses to correlate lines later.

```elixir
kept = Enum.reject(doc.items, &(&1.line_item_id == 28408886))
new_doc = %{doc | items: kept}

new_b64 = new_doc |> :erlang.term_to_binary() |> Base.encode64()
```

Use `%{doc | …}` (map update) rather than rebuilding the struct — it preserves
every untouched field and fails loudly on a typo'd key.

### Assertions to run before you use the output

```elixir
length(doc.items)                                       #=> 2
length(new_doc.items)                                   #=> 1
Enum.map(new_doc.items, & &1.line_item_id)              #=> [28408605]

# nothing but :items changed
Map.delete(new_doc, :items) == Map.delete(doc, :items)  #=> true

# totals still consistent with the surviving lines
Decimal.eq?(new_doc.total_net, Decimal.new("32.79"))    #=> true
Decimal.eq?(new_doc.total_gross, Decimal.new("40.0"))   #=> true
Decimal.eq?(
  new_doc.total_gross,
  Enum.reduce(new_doc.items, Decimal.new(0), &Decimal.add(&2, &1.total_gross))
)                                                       #=> true

# encode is lossless
(new_b64 |> Base.decode64!() |> :erlang.binary_to_term()) == new_doc   #=> true

# the resulting document still has lines at all — an empty one is silently skipped,
# see submission.ex:36-48
AccountingDocuments.Structs.BillingDocument.all_lines(new_doc) != []   #=> true

IO.puts(new_b64)
```

That last one is a real trap: `Submission.submit/2` returns `{:ok, :not_sent}`
and logs `"…has no line items; skipping submission to Invopop"` if `all_lines/1`
comes back empty. Strip every line and the resend appears to succeed while doing
nothing.

`receipt_number` needs no attention: the retry job overwrites it from the DB
column before routing (`retry_sending_failed_accounting_documents_job.ex:85-86`).

---

## 5. Write it back

There's an existing task —
`AccountingDocumentsRunner.EInvoicing.Common.Tasks.UpdateAccountingDocumentPayloadTask`
— which is a bare `Ecto.Changeset.change(%{payload_base64: payload}) |> Repo.update()`.
No validation, no decode check: whatever string you pass is what lands.

```bash
houston task run accounting-documents-web --namespace production \
  update_accounting_document_payload \
  -p ACCOUNTING_DOCUMENT_ID=4687595 \
  -p PAYLOAD_BASE64="<new_b64>" \
  --no-tui -w
```

Quote `PAYLOAD_BASE64` — base64 contains `+` and `/`, and may end in `=`.

Verify, then decode the stored value again and re-run the §4 assertions against
what's actually in the DB:

```bash
houston psql production accounting_documents -- -t -A -c "
SELECT length(payload_base64), md5(payload_base64), updated_at
FROM accounting_documents WHERE id = 4687595;"
```

Keep the original `.b64` file. It is your only rollback — feed it back through
the same task to restore.

---

## 6. ⚠ Persisted line items do not follow the payload

This is the trap that makes payload surgery on IT documents more than a one-liner.

`einvoicing_accounting_document_line_items` holds one row per line, and **the
resubmit will not rebuild them**. `line_items_already_inserted?/2`
(`create_accounting_document_and_tracker_action.ex:197-201`) sees existing rows and
skips insertion, on the reasoning that line items are written atomically with the
document so any row means the full set is present.

For 4687595:

```
 id  | index |  line_id  | line_item_id | line_item_type
-----+-------+-----------+--------------+---------------
 121 |     1 | 826971469 |     28408886 | line_item      <- the free item
 122 |     2 | 826971470 |     28408605 | line_item
```

The AdE line-ref webhook matches **GOBL line index `i` to the stored `index`**
(`invopop/it/smartreceipts/invoice.ex:137-158`):

```elixir
case stamp_line_ref(line_item, Map.get(line_refs, line_item.index)) do
```

Post-strip the GOBL has a single line at `i = 1` — `COPERTURA GEL` — so its
`it-ticket-line-ref` gets stamped onto row **121**, the free item. A later refund
builds its `line_refs` keyed by `{line_item_type, line_item_id}`
(`submission.ex:226-234`), so it would carry the wrong ref for `28408886` and none
for `28408605`. Silent until someone refunds the sale, then the corrective is
wrong.

**Fix: delete the rows before the resend** so the app re-inserts them from the
edited payload (`line_items_already_inserted?/2` → false → 1 row, `index 1`,
`line_item_id 28408605`).

```sql
-- houston psql production accounting_documents --write
BEGIN;
SELECT count(*) FROM einvoicing_accounting_document_line_items
WHERE accounting_document_id = 4687595;                     -- expect 2

DELETE FROM einvoicing_accounting_document_line_items
WHERE accounting_document_id = 4687595;
COMMIT;
```

No Houston task covers this, so it needs `--write`, which resolves against
`fresha-production-admin` / `-on-call` / `-database-superusers`.

Letting the app rebuild the rows beats hand-editing them (delete 121, set 122's
`index` to 1): same end state, but the app derives `index`, `line_id`,
`line_item_id`, `line_item_type`, `sale_id` and `provider_id` itself, so there's
nothing to get wrong.

Two conditions gate the rebuild — check both hold before relying on it:
`account_configurations.country_code` must be in `@line_items_country_codes`
(currently `["IT"]` only, `create_accounting_document_and_tracker_action.ex:24`),
and `plugin.integration` must be `:smart_receipts` for service charges to be
included as lines.

If the sale will never be refunded, leaving the rows alone is a defensible call
for a one-off — but make it deliberately.

---

## 7. Resend

### Eligibility comes first

`RetrySendingFailedAccountingDocumentsAction.get_failed_or_rejected_document_ids/1`
(`…/comarch/actions/retry_sending_failed_accounting_documents_action.ex:43-52`)
filters the input list down to documents whose tracker satisfies:

```elixir
where: at.upload_status == :failed_to_send or at.review_status == :rejected
```

**`FORCE=true` does not bypass this filter.** Force is read inside the *job* and
only skips the Comarch "already sent" check — which is a no-op for Invopop
anyway, since `check_if_document_already_sent(_, _), do: {:ok, false}`
(`retry_sending_failed_accounting_documents_job.ex:144`). A document whose tracker
is `{:sent, :approved}` is silently dropped from the list and the task still
reports success. Check the tracker first, every time.

4687595's tracker is `{upload_status: :sent, review_status: :rejected}` — already
eligible, so **skip the status flip**. Only reach for
`update_einvoice_trackers_status` (what `retry_invoices.js` does) when the tracker
is in neither state:

```bash
houston task run accounting-documents-web --namespace production \
  update_einvoice_trackers_status \
  -p E_INVOICE_TRACKER_IDS=4708916 \
  -p REVIEW_STATUS=rejected \
  -p UPLOAD_STATUS=failed_to_send \
  --no-tui -w
```

### The retry

```bash
houston task run accounting-documents-web --namespace production \
  retry_sending_failed_accounting_documents \
  -p ACCOUNTING_DOCUMENT_IDS=4687595 \
  -p FORCE=true \
  -p OBAN_STORER_ENABLED=1 \
  --no-tui -w
```

`OBAN_STORER_ENABLED` defaults to `"0"` (`config/runtime.exs:356`) and **nothing
is queued without it** — the task returns `:ok` having inserted no jobs. The
`accounting-documents-web` component already sets it to `"1"`
(`deploy/apps/production/values.yaml:88`), so passing it is belt-and-braces; pass
it anyway, because the failure mode is a silent no-op.

### What happens, end to end

`retry_sending_failed_accounting_documents_job.ex:71-98` →

1. Tracker → `review_status = :corrected`.
2. `payload_base64` decoded (your edited term), `receipt_number` overwritten from
   the DB column.
3. `InvoiceProcessingRouter.redirect(force_retry: true)`
   (`invoice_processing_router.ex:24-55`). `processable?` is true (not a refund);
   with `force_retry` it checks `processed?`, which is false because the tracker is
   `:corrected`, not `:approved`/`:waiting_for_review`
   (`billing_document_validator.ex:119-131`). Proceeds.
4. `SubmitInvoiceAction` → `TaxAuthorityDispatcher` → `IT.SmartReceipts.Submission`.
5. `CreateAccountingDocumentAndTrackerAction.call/1` finds document 4687595 by
   `sale_id` (i.e. `sale_id_64`), and `can_create_tracker/1` passes because
   `{:sent, :rejected}` is not one of the two blocked pairs (`{:sent, :waiting_for_review}`,
   `{:sent, :approved}`). It therefore **reuses the document** — the insert branch is
   skipped, so **your edited `payload_base64` is not overwritten**. A fresh tracker
   is inserted at `not_started/not_started` and `latest_tracker_id` repointed.
6. A new Invopop silo entry (`folder: "invoices"`, `draft: true`) plus a transform
   job, built fresh from the edited payload by `InvoiceGoblBuilder`. There is no
   idempotency key — each resend creates a new silo entry.
7. On success the tracker gets the entry id as `web_doc_id`; on failure
   `upload_status = :failed_to_send`.

Step 5 is the important one: **the retry does not create a duplicate document**,
and it does not clobber your edit.

### Verify

```bash
houston psql production accounting_documents -- -c "
SELECT id, review_status, upload_status, web_doc_id, created_at
FROM e_invoice_trackers WHERE accounting_document_id = 4687595 ORDER BY id;"

houston psql production accounting_documents -- -c "
SELECT id, index, line_id, line_item_id, external_reference_id
FROM einvoicing_accounting_document_line_items
WHERE accounting_document_id = 4687595 ORDER BY index;"

houston psql production accounting_documents -- -c "
SELECT id, external_invoice_reference, left(tax_authority_document, 60), deleted_at
FROM e_invoice_compliance_records WHERE accounting_document_id = 4687595;"
```

Expected once the AdE responds: a new tracker at `{:sent, :approved}`, one line
item row with a non-null `external_reference_id`, and a compliance record with an
`external_invoice_reference`. Compliance records are soft-deleted on resubmission,
so expect the old one (if any) to have `deleted_at` set and the newest to be live.

Approval is asynchronous — it arrives by Invopop webhook. Watch
`/dd-logs accounting-documents production` for
`Smart Receipts invoice submitted successfully` (submission accepted) and then the
webhook handler's outcome. `{:sent, :approved}` is the finish line, not
`web_doc_id` being populated.

---

## 8. Order of operations

1. Read `payload_base64` + tracker + plugin + line items. **Save the original base64.**
2. Decode; confirm what you're removing and that totals survive it.
3. Edit, re-encode, run the §4 assertions.
4. **Delete the line-item rows** (§6) — before the resend, not after.
5. `update_accounting_document_payload`; verify by decoding from the DB.
6. Check tracker eligibility; flip only if needed.
7. `retry_sending_failed_accounting_documents` with `OBAN_STORER_ENABLED=1`.
8. Watch Datadog until the tracker reaches `{:sent, :approved}`.

Steps 4 and 5 both write and neither is transactional with the other. If step 5
fails, re-run it — the task is idempotent. If step 7 needs repeating, re-check
eligibility first: the previous attempt will have moved the tracker to
`:corrected`, which is **not** an eligible state, so you'll need the status flip
the second time round.

## Prereqs

- VPN up, `houston` authenticated. Reads use `fresha-production-developer`;
  the §6 `DELETE` needs `--write` (`fresha-production-admin` / `-on-call` /
  `-database-superusers`).
- Local Elixir only if you decode/re-encode off-pod (`asdf`; pin with
  `ASDF_ELIXIR_VERSION` / `ASDF_ERLANG_VERSION` when outside a `.tool-versions` dir).

## Related

- [retry_invoices](../retry_invoices/) — bulk version of §7 (status flip + force
  retry) for KSA trackers. Note it targets `accounting-documents-web` and does not
  pass `OBAN_STORER_ENABLED`, relying on the component's own `"1"`.
