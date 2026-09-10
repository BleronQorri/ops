-- ============================================================================
-- match_credit_notes_to_invoices — the queries, and the matching algorithm in SQL
--
--   houston psql production accounting_documents -- -f cross-check.sql
--   houston psql production shedul               -- -f cross-check.sql
--
-- §1 is what the scripts actually run, transcribed verbatim from the source.
-- §2 is `pickInvoice` reimplemented as SQL — an independent path to the same
--    answer, so `rank = 1` should equal the CSV's invoice_reference on every row.
-- §3 is a check that owes nothing to the algorithm at all.
-- §4 is for after a write.
--
-- Two databases, so nothing here joins across them: `einvoice_reference` is the
-- key between the two sides (a uuid, uniquely indexed on both). Run §1.1 first to
-- get the references the shedul queries need.
--
-- Read-only throughout. Amounts are stored in MINOR UNITS; queries divide by 100.
-- Stored signs are inconsistent, so magnitudes are compared (abs()).
--
-- ⚠ A run of `match_credit_notes_to_invoices.js` now emits the statements it actually executed
-- (see "SQL executed" in the Markdown report, or the companion .sql file next to
-- the decode CSV). Those are the truth; this file is a curated copy and can drift.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- §0  The cohort — the 34 rejected B2B credit notes
--
-- Source of truth is the sheet, not this file:
-- https://docs.google.com/spreadsheets/d/1ziLw2i6ISmye2DZV0dSThf0jscP9lpngPow5jZDwfuU
-- (gid 1304794537). Verified identical, 34 in each, zero diff either way.
-- ----------------------------------------------------------------------------

-- accounting_documents.id
--   4762874, 4762876, 4762877, 4762878, 4762879, 4762884, 4762887, 4762891,
--   4762892, 4762893, 4762895, 4762906, 4762909, 4762910, 4762917, 4762918,
--   4762922, 4762924, 4762930, 4762934, 4762938, 4762939, 4762945, 4762952,
--   4762958, 4762961, 4762965, 4762972, 4762973, 4762977, 4762980, 4762988,
--   4836650, 4762882

-- einvoice_reference — §1.1 regenerates this
--   '73ad2d96-b828-4cc8-8ce1-d2a8a24bb430', '7c4991d9-72f8-444f-8049-900fec873ab8',
--   'd207522d-fd5a-4c3b-aeb8-639da1d2e639', 'ea9eb4c2-0b49-436a-81db-0d2b5eec0f70',
--   '31637758-f33f-4d34-bbb9-de61ec5d2665', '0561f64c-39f4-42dd-bd10-fbe801360d1e',
--   'dcb4d224-f140-46dd-8562-1209e210fdaf', 'a1c912a5-bf9e-448f-b849-aaafb5136e59',
--   'fdc44abf-0c5d-4de3-b149-b722f2da766e', '8bdb2d3d-f161-4133-852f-81d62c15f27e',
--   'b2df612e-74e3-4a7c-b7be-d19ba4524225', 'ef8d3dd0-5153-4e5b-9417-cdcf211c85de',
--   '72b92e96-dbfc-4334-9ace-257a80a04bca', 'bce209d9-0ee2-4b85-b5a7-759d41f3b425',
--   'a74ca05a-0638-4b76-86b6-a4a243ca23da', 'c15899a6-f092-4cd5-bfc0-d71813ce35fc',
--   'e9feb969-3fba-4f26-b755-234dd724a025', '0ede0d94-6c1e-4c1b-9ede-0cfb327eb94b',
--   'e0241954-805c-4c0f-927f-321acbc89966', 'c02d9a9d-3c98-4ece-93c2-9da8182e39fc',
--   '0207faf3-8a8d-48ff-90b2-8375afe4915b', 'b245b7ef-25c2-4934-9965-fbb36aab2260',
--   '4c17a1ea-3642-4bd9-a64e-777ff0755abf', '2dce229c-ffbc-41d2-ab17-427374a185c9',
--   '56c4724f-554b-4b15-bb37-438c189775f0', 'de4faaf6-9608-4a22-a1e3-04dc18fa7e91',
--   '487509cd-60f2-4a8c-af86-d7f3ea02246e', '4114f223-bfb7-4b89-bbe1-d8f66489416c',
--   '86b66639-c2d6-4e92-a3f5-b33ac206493c', 'c4c6564f-357a-4cdc-b6a3-057f43e26695',
--   'fc62fb46-ebae-4170-ad47-88278f793d5a', 'c8d0db30-c417-450e-ae41-6d4c7a42ba54',
--   '9882ca68-3ee3-4fb4-8e51-af0cc8be5096', '56fd4eb0-7113-48b4-9f15-eb6d976bc3f7'


-- ============================================================================
-- §1  THE QUERIES THE SCRIPTS RUN
--
-- Verbatim, in execution order, with the IN lists filled in. Four for `matrix`,
-- a fifth for `decode`. The `::text` casts and `coalesce(…, '')` wrappers are
-- there for the scripts' own pipe-delimited parser — psql returns an empty field
-- for NULL, and coalesce makes that unambiguous rather than "NULL or ''". They do
-- not change which rows come back; drop them if you are reading by eye.
-- ============================================================================

-- §1.1  matrix step 1 / accounting_documents — fetchSuppliedDocs()
--
-- The input validation: a row qualifies only if document_type = 'credit_note' AND
-- einvoice_reference IS NOT NULL. One with a sale_id instead is a B2C sale refund,
-- not partner billing.
--
-- ⚠ sale_id vs sale_id_64. Both columns exist; on newer rows the int4 `sale_id`
-- is NULL and the bigint `sale_id_64` holds the value. The Ecto schema aliases it
-- (`field(:sale_id, :integer, source: :sale_id_64)`), so SQL must say sale_id_64
-- while Elixir says sale_id. Backwards makes lookups look broken when they aren't.
--
-- ⚠ ad.provider_id is NULL on these rows. The provider comes from shedul (§1.2).
SELECT ad.id::text, ad.document_type::text, coalesce(ad.receipt_number, ''),
       coalesce(ad.einvoice_reference, ''), coalesce(ad.sale_id_64::text, ''),
       coalesce(ad.deleted_at::text, ''),
       coalesce(t.review_status::text, ''), coalesce(t.upload_status::text, '')
FROM accounting_documents ad
LEFT JOIN e_invoice_trackers t ON t.id = ad.latest_tracker_id
WHERE ad.id IN (4836650, 4762882)        -- <<< the cohort
ORDER BY ad.id;

-- §1.2  matrix step 2 / shedul — fetchShedulCreditNotes()
--
-- Resolves each credit note through einvoice_reference to its provider, billing
-- period and VALUE.
--
-- ⚠ `item_value` — sum(provider_invoice_items.fee) — is the figure the match uses,
-- NOT c.total. On 280 of 295 production credit notes `total` does not equal its
-- own items: it carries the co-created INVOICE's total. Matching against it would
-- compare an invoice's total with a copy of itself and pass by construction.
-- Invoice totals are self-consistent on all 12 893 e-invoiced rows, so the
-- invoice side (§1.3) uses `total` as stored.
SELECT c.einvoice_reference::text, c.id::text, c.provider_id::text,
       coalesce(c.invoice_reference, ''), c.billing_start::text, c.billing_end::text,
       c.invoice_date::text, coalesce(c.einvoice_status::text, ''), c.total::text,
       coalesce(i.item_value::text, ''), c.created_at::text
FROM provider_invoices c
LEFT JOIN (
  SELECT provider_invoice_id, sum(fee) AS item_value
  FROM provider_invoice_items GROUP BY provider_invoice_id
) i ON i.provider_invoice_id = c.id
WHERE c.einvoice_reference IN (          -- <<< references from §1.1
        '56fd4eb0-7113-48b4-9f15-eb6d976bc3f7',
        '0561f64c-39f4-42dd-bd10-fbe801360d1e')
  AND c.billing_document_type = 'credit_note'
ORDER BY c.provider_id, c.id;

-- §1.3  matrix step 3 / shedul — fetchProviderInvoices()
--
-- The candidate pool: every E-INVOICED invoice of those providers, in ANY billing
-- period. No period filter, because the amount constraint is absolute and the
-- period is not — a match from another month is legitimate, and for 37 of 295
-- production credit notes it is the only possibility.
--
-- `einvoice_reference IS NOT NULL` is the deliberate scope. Without it the pool
-- includes the 1.8M invoices predating the KSA rollout and the 1.25M
-- `not_applicable` non-KSA ones. Those are not failed emissions — the check for
-- "an e-invoicing provider's invoice, after the cutoff, missing a reference"
-- returns 0 — but matching a ZATCA credit note to a document ZATCA has never seen
-- is not a useful answer. It costs 2 of 295 matches.
--
-- ⚠ einvoice_status is NOT filtered on. See §2.4.
SELECT i.provider_id::text, i.billing_start::text, i.billing_end::text,
       i.id::text, coalesce(i.invoice_reference, ''), i.invoice_date::text,
       coalesce(i.einvoice_status::text, ''), i.einvoice_reference::text,
       i.total::text, i.created_at::text
FROM provider_invoices i
WHERE i.provider_id IN (1092540, 769991)   -- <<< provider_ids from §1.2
  AND i.billing_document_type = 'invoice'
  AND i.einvoice_reference IS NOT NULL
ORDER BY i.provider_id, i.created_at, i.id;

-- §1.4  matrix step 4 / accounting_documents — fetchInvoiceTrackers()
--
-- The matched invoices as accounting_documents sees them. `receipt_number` here is
-- the value written into the credit note's previous_receipt_number — read from
-- this database rather than shedul's invoice_reference, because the field is
-- consumed by the e-invoicing side. They agree on all 34; the script reports a
-- divergence rather than assuming there is none.
SELECT ad.einvoice_reference, ad.id::text, coalesce(ad.receipt_number, ''),
       coalesce(t.review_status::text, ''), coalesce(t.upload_status::text, '')
FROM accounting_documents ad
LEFT JOIN e_invoice_trackers t ON t.id = ad.latest_tracker_id
WHERE ad.document_type = 'invoice'
  AND ad.einvoice_reference IN (         -- <<< the MATCHED invoices' references
        '00000000-0000-0000-0000-000000000000')
ORDER BY ad.id;

-- §1.5  decode step 1 / accounting_documents — fetchPayloads()
--
-- payload_base64 is Base.encode64(:erlang.term_to_binary(%BillingDocument{})), so
-- every value starts `g3` (0x83, the ETF version byte). Only a BEAM can read it —
-- use `--mode decode`, not SQL.
SELECT ad.id::text, coalesce(ad.receipt_number, ''),
       coalesce(ad.document_type::text, ''), coalesce(ad.deleted_at::text, ''),
       coalesce(ad.payload_base64, '')
FROM accounting_documents ad
WHERE ad.id IN (4836650, 4762882)        -- <<< the cohort
ORDER BY ad.id;


-- ============================================================================
-- §2  THE ALGORITHM, IN SQL
--
-- `pickInvoice()` in match_credit_notes_to_invoices.js, reimplemented. The point is that this is
-- an independent path to the same answer: `rank = 1` must equal the CSV's
-- invoice_reference for every credit note, and a disagreement is a bug in one of
-- the two implementations.
--
-- The JS, for auditing the translation:
--
--   const qualifying = candidates.filter((i) => i.total >= creditNote.value);
--   qualifying.sort((a, b) => {
--     period = Number(!samePeriod(a, cn)) - Number(!samePeriod(b, cn));
--     if (period) return period;                       -- 1. own period first
--     aBefore = a.createdAt <= cn.createdAt;
--     bBefore = b.createdAt <= cn.createdAt;
--     if (aBefore !== bBefore) return aBefore ? -1 : 1;-- 2. already existed first
--     if (a.createdAt !== b.createdAt) {
--       return aBefore ? b.createdAt.localeCompare(a.createdAt)   -- 3a. latest of those
--                      : a.createdAt.localeCompare(b.createdAt);  -- 3b. earliest of the rest
--     }
--     return Number(b.id) - Number(a.id);              -- 4. highest id
--   });
--
-- So, in order:
--   HARD FILTER  invoice.total >= credit note value, on the E-INVOICED pool of §1.3.
--                This is the ONLY hard constraint. Note the invoice total is used
--                as stored and is NOT abs()'d — the 194 production invoices with a
--                negative total therefore never qualify, which is intended.
--   1. the credit note's own billing period
--   2. created at or before the credit note — one that did not yet exist cannot be
--      the document being credited, so later invoices are a last resort
--   3. nearest in time: the LATEST of the earlier ones, or the EARLIEST of the
--      later ones. Both mean "closest to the credit note".
--   4. highest id
--
-- The two CASE expressions look like they need NULLS handling and do not: key 2
-- has already partitioned the rows into the before-group and the after-group, and
-- within each group the relevant CASE is non-NULL for every row.
-- ============================================================================

-- §2.1  Every qualifying invoice, ranked. Drop the WHERE on rank to see the
-- runners-up and why the winner beat them.
WITH cn AS (
  SELECT c.id, c.provider_id, c.billing_start, c.billing_end, c.created_at,
         c.invoice_reference AS credit_note,
         -- Exactly the script's value: the items sum, falling back to the stored
         -- total only when a credit note has no items at all, as a magnitude.
         abs(coalesce((SELECT sum(fee) FROM provider_invoice_items
                       WHERE provider_invoice_id = c.id), c.total)) AS cn_value
  FROM provider_invoices c
  WHERE c.einvoice_reference IN (        -- <<< references from §1.1
          '56fd4eb0-7113-48b4-9f15-eb6d976bc3f7',
          '0561f64c-39f4-42dd-bd10-fbe801360d1e')
    AND c.billing_document_type = 'credit_note'
),
ranked AS (
  SELECT cn.credit_note,
         cn.cn_value,
         cn.billing_start AS cn_start,
         cn.billing_end   AS cn_end,
         i.id             AS provider_invoice_id,
         i.invoice_reference,
         i.total,
         i.billing_start  AS inv_start,
         i.billing_end    AS inv_end,
         i.einvoice_status,
         (i.billing_start = cn.billing_start AND i.billing_end = cn.billing_end) AS same_period,
         (i.created_at <= cn.created_at) AS existed_already,
         row_number() OVER (
           PARTITION BY cn.id
           ORDER BY (i.billing_start = cn.billing_start
                     AND i.billing_end = cn.billing_end)          DESC,  -- 1
                    (i.created_at <= cn.created_at)                DESC,  -- 2
                    CASE WHEN i.created_at <= cn.created_at
                         THEN i.created_at END                     DESC,  -- 3a
                    CASE WHEN i.created_at >  cn.created_at
                         THEN i.created_at END                     ASC,   -- 3b
                    i.id                                           DESC   -- 4
         ) AS rank
  FROM cn
  JOIN provider_invoices i
    ON i.provider_id = cn.provider_id
   AND i.billing_document_type = 'invoice'
   AND i.einvoice_reference IS NOT NULL        -- the §1.3 pool
   AND i.total >= cn.cn_value                  -- the only hard constraint
)
SELECT credit_note, cn_value / 100.0 AS cn_value, cn_start, cn_end,
       rank, invoice_reference, provider_invoice_id, total / 100.0 AS inv_total,
       inv_start, inv_end, same_period, existed_already, einvoice_status
FROM ranked
WHERE rank <= 3                                -- <<< drop for the full pool
ORDER BY credit_note, rank;

-- §2.2  The winners only — one row per credit note, to diff straight against the
-- CSV's invoice_reference column.
WITH cn AS (
  SELECT c.id, c.provider_id, c.billing_start, c.billing_end, c.created_at,
         c.invoice_reference AS credit_note,
         abs(coalesce((SELECT sum(fee) FROM provider_invoice_items
                       WHERE provider_invoice_id = c.id), c.total)) AS cn_value
  FROM provider_invoices c
  WHERE c.einvoice_reference IN (        -- <<< references from §1.1
          '56fd4eb0-7113-48b4-9f15-eb6d976bc3f7',
          '0561f64c-39f4-42dd-bd10-fbe801360d1e')
    AND c.billing_document_type = 'credit_note'
),
ranked AS (
  SELECT cn.credit_note, cn.cn_value, cn.billing_start AS cn_start,
         cn.billing_end AS cn_end, i.invoice_reference, i.total,
         i.billing_start AS inv_start, i.billing_end AS inv_end,
         row_number() OVER (
           PARTITION BY cn.id
           ORDER BY (i.billing_start = cn.billing_start
                     AND i.billing_end = cn.billing_end)      DESC,
                    (i.created_at <= cn.created_at)            DESC,
                    CASE WHEN i.created_at <= cn.created_at
                         THEN i.created_at END                 DESC,
                    CASE WHEN i.created_at >  cn.created_at
                         THEN i.created_at END                 ASC,
                    i.id                                       DESC
         ) AS rank
  FROM cn
  JOIN provider_invoices i
    ON i.provider_id = cn.provider_id
   AND i.billing_document_type = 'invoice'
   AND i.einvoice_reference IS NOT NULL
   AND i.total >= cn.cn_value
)
SELECT credit_note,
       cn_value / 100.0 AS cn_value, cn_start, cn_end,
       invoice_reference,
       total / 100.0 AS inv_total, inv_start, inv_end,
       CASE WHEN (cn_start, cn_end) = (inv_start, inv_end)
            THEN 'same' ELSE 'DIFFERENT' END AS period
FROM ranked
WHERE rank = 1
ORDER BY credit_note;

-- §2.3  UNMATCHED: no e-invoiced invoice of that provider, in any period, is
-- large enough. Shows the largest available, which is the whole explanation.
-- 7 of 295 production credit notes land here; 0 of this cohort's 34.
WITH cn AS (
  SELECT c.id, c.provider_id, c.invoice_reference AS credit_note,
         abs(coalesce((SELECT sum(fee) FROM provider_invoice_items
                       WHERE provider_invoice_id = c.id), c.total)) AS cn_value
  FROM provider_invoices c
  WHERE c.einvoice_reference IN (        -- <<< references from §1.1
          '56fd4eb0-7113-48b4-9f15-eb6d976bc3f7')
    AND c.billing_document_type = 'credit_note'
)
SELECT cn.credit_note,
       cn.cn_value / 100.0 AS cn_value,
       max(i.total) / 100.0 AS largest_invoice,
       count(*) AS candidates,
       count(*) FILTER (WHERE i.total >= cn.cn_value) AS qualifying
FROM cn
LEFT JOIN provider_invoices i
  ON i.provider_id = cn.provider_id
 AND i.billing_document_type = 'invoice'
 AND i.einvoice_reference IS NOT NULL
GROUP BY cn.credit_note, cn.cn_value
ORDER BY qualifying, cn.credit_note;

-- §2.4  ⚠ NOT THE ALGORITHM — einvoice_status plays no part in matching.
--
-- Kept because it is the obvious thing to reach for, and an earlier version of
-- the script did, dropping candidates whose status was `rejected` or `refunded`
-- on the strength of shedul's INVALID_EINVOICE_STATUSES. That was wrong:
--
--   * Nothing in the live codebase ever WRITES `refunded`. provider_invoice.rb
--     defines constants for approved/pending/not_applicable only, and
--     update_provider_invoice_status_service writes just approved/rejected. Every
--     `refunded` row shares one invoice_date (2025-12-31) — a legacy marker.
--   * shedul uses that constant to answer a different question — "does this period
--     already have an invoice, or should I create one?" — not "which invoice does
--     this credit note credit".
--   * Invoices and their credit notes are created in the SAME transaction, 23-24 ms
--     apart. For 43 of the 63 then-ambiguous credit notes the co-created invoice
--     was the `refunded` one — precisely the row the status rule discarded.
--
-- So this query gives a DIFFERENT answer from §2.2 by design. Useful as a second
-- opinion; not a bug when it disagrees. It also ranks purely by proximity, with no
-- period preference and no direction preference.
WITH cn AS (
  SELECT c.provider_id, c.billing_start, c.billing_end, c.created_at,
         abs(coalesce(sum(it.fee), c.total)) AS cn_value
  FROM provider_invoices c
  LEFT JOIN provider_invoice_items it ON it.provider_invoice_id = c.id
  WHERE c.id = 3903668                  -- <<< ONE credit note, by provider_invoices.id
  GROUP BY c.provider_id, c.billing_start, c.billing_end, c.created_at, c.total
)
SELECT i.id,
       i.invoice_reference,
       i.total / 100.0     AS inv_total,
       cn.cn_value / 100.0 AS cn_value,
       i.billing_start,
       i.billing_end,
       i.einvoice_status,
       round(extract(epoch FROM (i.created_at - cn.created_at)) / 86400.0, 1) AS days_apart
FROM provider_invoices i, cn
WHERE i.provider_id = cn.provider_id
  AND i.billing_document_type = 'invoice'
  AND i.einvoice_status = 'approved'
  AND i.total >= cn.cn_value
ORDER BY abs(extract(epoch FROM (i.created_at - cn.created_at)))
LIMIT 1;                                -- drop for the runners-up


-- ============================================================================
-- §3  The check that owes nothing to the algorithm: co-creation
--
-- Invoices and their credit notes are written in ONE transaction by
-- Areas::ProviderInvoicing::CreateProviderInvoiceService#handle_invoice_and_credit_note,
-- which splits a month's items by SIGN — positive becomes the invoice, negative
-- the credit note. So when the month has an invoice, it was written milliseconds
-- before the credit note by the same code path. That is an opinion formed with no
-- reference to the amount rule, which is what makes this a real check rather than
-- a restatement of §2.
--
-- Result on the 34: 29 agree, 27-129 ms apart, invoice always written first. The 5
-- that differ are exactly the 5 cross-period matches — in each the co-created
-- invoice is too small (`big_enough = false`), except CN/1098, whose month has no
-- invoice at all.
--
-- ⚠ Unavailable precisely where the answer is least obvious: a credit note whose
-- own month has no invoice, or whose invoice is too small, has no co-created
-- counterpart to agree with.
WITH cn AS (
  SELECT c.id, c.provider_id, c.billing_start, c.billing_end, c.created_at,
         c.invoice_reference AS credit_note,
         abs(coalesce((SELECT sum(fee) FROM provider_invoice_items
                       WHERE provider_invoice_id = c.id), c.total)) AS cn_value
  FROM provider_invoices c
  WHERE c.einvoice_reference IN (        -- <<< references from §1.1
          '56fd4eb0-7113-48b4-9f15-eb6d976bc3f7',
          '0561f64c-39f4-42dd-bd10-fbe801360d1e')
    AND c.billing_document_type = 'credit_note'
)
SELECT cn.credit_note,
       cn.cn_value / 100.0 AS cn_value,
       coalesce(i.invoice_reference, '(none)') AS co_created_invoice,
       i.total / 100.0 AS inv_total,
       round(extract(epoch FROM (i.created_at - cn.created_at)) * 1000) AS ms_apart,
       (i.total >= cn.cn_value) AS big_enough
FROM cn
LEFT JOIN provider_invoices i
  ON i.provider_id = cn.provider_id
 AND i.billing_document_type = 'invoice'
 AND i.billing_start = cn.billing_start
 AND i.billing_end   = cn.billing_end
 AND abs(extract(epoch FROM (i.created_at - cn.created_at))) < 5
ORDER BY cn.credit_note;


-- ============================================================================
-- §4  After a write — did it take?
-- ============================================================================

-- §4.1  ⚠ Eligibility FIRST, before re-driving. The retry action filters the input
-- list down to `upload_status = 'failed_to_send' OR review_status = 'rejected'`,
-- and FORCE=true does NOT bypass it — a document in neither state is silently
-- dropped and the task still reports success.
SELECT ad.id, ad.receipt_number, t.review_status, t.upload_status,
       (t.upload_status = 'failed_to_send' OR t.review_status = 'rejected') AS retry_eligible
FROM accounting_documents ad
JOIN e_invoice_trackers t ON t.id = ad.latest_tracker_id
WHERE ad.id IN (4836650, 4762882)        -- <<< the cohort
ORDER BY retry_eligible, ad.id;

-- §4.2  The payload changed. ⚠ Length and md5 change on ANY re-encode, because
-- term_to_binary does not preserve map key order — so these prove only that
-- SOMETHING was written, never that it was the right thing. To check content,
-- decode it: `./match_credit_notes_to_invoices.js --mode decode --ids <id> --yes`.
SELECT id, receipt_number, length(payload_base64) AS b64_len,
       md5(payload_base64), updated_at
FROM accounting_documents
WHERE id IN (4836650)                    -- <<< what you wrote
ORDER BY id;

-- §4.3  Tracker history. A re-drive sets review_status = 'corrected', then inserts
-- a FRESH tracker at not_started/not_started and repoints latest_tracker_id.
-- Expect a new row, and eventually {sent, approved}.
SELECT t.id, t.accounting_document_id, t.review_status, t.upload_status,
       t.web_doc_id, t.created_at,
       (t.id = ad.latest_tracker_id) AS is_latest
FROM e_invoice_trackers t
JOIN accounting_documents ad ON ad.id = t.accounting_document_id
WHERE t.accounting_document_id IN (4836650)   -- <<< what you wrote
ORDER BY t.accounting_document_id, t.id;

-- §4.4  Where the cohort stands, one line. Run before and after any re-drive.
SELECT t.review_status, t.upload_status, count(*)
FROM accounting_documents ad
JOIN e_invoice_trackers t ON t.id = ad.latest_tracker_id
WHERE ad.id IN (4836650, 4762882)        -- <<< the cohort
GROUP BY 1, 2
ORDER BY 3 DESC;

-- §4.5  Compliance records — the tax authority's answer. Soft-deleted on
-- resubmission, so expect the old one to have deleted_at set and the newest live.
SELECT id, accounting_document_id, external_invoice_reference, created_at, deleted_at
FROM e_invoice_compliance_records
WHERE accounting_document_id IN (4836650)     -- <<< what you wrote
ORDER BY accounting_document_id, id;

-- §4.6  Why it was rejected. Often ALL of these are empty — a rejection can arrive
-- by webhook and leave nothing but review_status. The reason is then only in
-- Datadog (service accounting-documents, env production).
SELECT id, accounting_document_id, created_at, left(raw_error::text, 800)
FROM accounting_document_error_logs
WHERE accounting_document_id IN (4836650)     -- <<< what you wrote
ORDER BY id;

SELECT id, accounting_document_id, log_type, metadata, created_at
FROM accounting_documents_logs
WHERE accounting_document_id IN (4836650)     -- <<< what you wrote
ORDER BY id;

-- §4.7  Line items. Zero rows for THIS cohort — persistence is gated on
-- account_configurations.country_code IN ('IT'). Kept because
-- edit_document_payload §6 turns on it: for an IT document these rows do NOT
-- follow an edited payload, and a stale `index` silently mis-stamps a later refund.
SELECT id, accounting_document_id, index, line_id, line_item_id,
       line_item_type, external_reference_id
FROM einvoicing_accounting_document_line_items
WHERE accounting_document_id IN (4836650)     -- <<< what you wrote
ORDER BY accounting_document_id, index;
