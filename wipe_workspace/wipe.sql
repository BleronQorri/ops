-- Wipe the accounting-documents cluster for a whole COUNTRY (staging reset).
--
-- Gated by account_configurations.country_code (e.g. ES, IT): every provider/config in
-- that country and all of its e-invoicing + accounting-document rows are removed.
--
-- Single atomic statement: every data-modifying CTE shares one snapshot and all
-- FK checks fire once at statement end, so children + parents delete together
-- regardless of CTE order -- as long as EVERY referencing table is covered.
--
-- Scope: ONLY the accounting-documents / e-invoicing cluster. Does NOT touch the
-- invoices/* cluster (no country/provider column; linked via invoice_parties.external_id)
-- or global tables (comarch_jwt_tokens, e_invoice_unmatched_compliance_records, oban_*,
-- outbox_events).
--
-- Run (staging):
--   houston psql eng-orion accounting-documents --write -- -v cc=<COUNTRY_CODE> -f wipe.sql
-- Dry-run first with preview.sql (no --write). To test without persisting, swap COMMIT -> ROLLBACK.

\set ON_ERROR_STOP on

BEGIN;

WITH cfg AS (
  SELECT id FROM account_configurations WHERE country_code = :'cc'
),
plg AS (
  SELECT id FROM account_configuration_plugins WHERE account_configuration_id IN (SELECT id FROM cfg)
),
doc AS (
  SELECT id FROM accounting_documents WHERE account_configuration_id IN (SELECT id FROM cfg)
),
-- children of accounting_documents (none have ON DELETE CASCADE)
d1  AS (DELETE FROM accounting_document_error_logs             WHERE accounting_document_id IN (SELECT id FROM doc)),
d2  AS (DELETE FROM accounting_documents_logs                  WHERE accounting_document_id IN (SELECT id FROM doc)),
d3  AS (DELETE FROM e_invoice_compliance_records               WHERE accounting_document_id IN (SELECT id FROM doc)),
d4  AS (DELETE FROM einvoicing_accounting_document_line_items  WHERE accounting_document_id IN (SELECT id FROM doc)),  -- ADDED: was missing; FK has no cascade
d5  AS (DELETE FROM e_invoice_trackers                         WHERE accounting_document_id IN (SELECT id FROM doc)),  -- also SET NULLs accounting_documents.latest_tracker_id
d6  AS (DELETE FROM accounting_documents                       WHERE id IN (SELECT id FROM doc)),
-- e-invoicing children of plugins / configs
d7  AS (DELETE FROM einvoice_integration_issues               WHERE account_configuration_plugin_id IN (SELECT id FROM plg)),
d8  AS (DELETE FROM einvoice_integration_application_requests  WHERE account_configuration_plugin_id IN (SELECT id FROM plg)
                                                                  OR account_configuration_id IN (SELECT id FROM cfg)),
d9  AS (DELETE FROM e_invoicing_configuration_logs            WHERE account_configuration_id IN (SELECT id FROM cfg)),
d10 AS (DELETE FROM account_configuration_addresses          WHERE account_configuration_id IN (SELECT id FROM cfg)),
d11 AS (DELETE FROM e_invoice_it_smart_receipts_configuration WHERE plugin_id IN (SELECT id FROM plg)),
d12 AS (DELETE FROM account_configuration_plugins            WHERE account_configuration_id IN (SELECT id FROM cfg))
DELETE FROM account_configurations WHERE id IN (SELECT id FROM cfg);

-- Reassurance: after COMMIT this must be 0 (FK integrity would have aborted otherwise).
SELECT 'remaining account_configurations' AS check, count(*) AS n
  FROM account_configurations WHERE country_code = :'cc';

COMMIT;
