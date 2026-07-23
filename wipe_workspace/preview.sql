-- Read-only preview of what wipe.sql will delete for a whole COUNTRY (staging reset).
-- Run WITHOUT --write:
--   houston psql eng-orion accounting-documents -- -v cc=<COUNTRY_CODE> -f preview.sql

\set ON_ERROR_STOP on

WITH cfg AS (SELECT id FROM account_configurations WHERE country_code = :'cc'),
     plg AS (SELECT id FROM account_configuration_plugins WHERE account_configuration_id IN (SELECT id FROM cfg)),
     doc AS (SELECT id FROM accounting_documents WHERE account_configuration_id IN (SELECT id FROM cfg))
SELECT 'account_configurations'                    AS tbl, count(*) AS n FROM cfg
UNION ALL SELECT 'account_configuration_plugins',            count(*) FROM plg
UNION ALL SELECT 'account_configuration_addresses',          count(*) FROM account_configuration_addresses          WHERE account_configuration_id IN (SELECT id FROM cfg)
UNION ALL SELECT 'e_invoice_it_smart_receipts_configuration',count(*) FROM e_invoice_it_smart_receipts_configuration WHERE plugin_id IN (SELECT id FROM plg)
UNION ALL SELECT 'einvoice_integration_issues',              count(*) FROM einvoice_integration_issues              WHERE account_configuration_plugin_id IN (SELECT id FROM plg)
UNION ALL SELECT 'einvoice_integration_application_requests',count(*) FROM einvoice_integration_application_requests WHERE account_configuration_plugin_id IN (SELECT id FROM plg) OR account_configuration_id IN (SELECT id FROM cfg)
UNION ALL SELECT 'e_invoicing_configuration_logs',           count(*) FROM e_invoicing_configuration_logs           WHERE account_configuration_id IN (SELECT id FROM cfg)
UNION ALL SELECT 'accounting_documents',                     count(*) FROM doc
UNION ALL SELECT 'accounting_document_error_logs',           count(*) FROM accounting_document_error_logs           WHERE accounting_document_id IN (SELECT id FROM doc)
UNION ALL SELECT 'accounting_documents_logs',                count(*) FROM accounting_documents_logs                WHERE accounting_document_id IN (SELECT id FROM doc)
UNION ALL SELECT 'e_invoice_compliance_records',             count(*) FROM e_invoice_compliance_records             WHERE accounting_document_id IN (SELECT id FROM doc)
UNION ALL SELECT 'e_invoice_trackers',                       count(*) FROM e_invoice_trackers                       WHERE accounting_document_id IN (SELECT id FROM doc)
UNION ALL SELECT 'einvoicing_accounting_document_line_items',count(*) FROM einvoicing_accounting_document_line_items WHERE accounting_document_id IN (SELECT id FROM doc)
ORDER BY tbl;
