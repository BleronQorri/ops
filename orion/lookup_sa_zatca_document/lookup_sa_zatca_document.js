#!/usr/bin/env node
"use strict";

// lookup_sa_zatca_document — find one KSA invoice or credit note by its number and
// say where it is on its way to ZATCA.
//
// Self-contained on purpose: one directory, one entrypoint, no shared library.
// Copy helpers from a sibling script rather than importing them.
//
// Transport: the Metabase CLI (`mb query`) against Snowflake Postgres, the
// Debezium replica of accounting_documents. No houston, no VPN, no Comarch token.
//
// Read-only: two SELECTs, nothing to dry-run.
//   1. the documents with that number, their account configuration, their plugin
//      and the tracker that last tried to send them
//   2. for those documents only: every tracker, every error Comarch returned, every
//      ZATCA compliance record (the QR) and the document's log
//
// Why not Comarch itself: everything Comarch says about a document is already
// written down here. A tracker's id is the ControlNumber it was sent under, its
// web_doc_id is Comarch's WebDocId, accounting_document_error_logs.raw_error is the
// verbatim /api/status/error answer, and the QR is the APERAK ZATCA sent back.
// Asking Comarch live would need production credentials and a /api/auth call, and
// a second session on the service's login is not a risk worth a lookup.

const fs = require("fs");
const { spawnSync } = require("child_process");
const os = require("os");
const path = require("path");
const readlinePromises = require("readline/promises");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { header: sgr("1;37"), cmd: sgr("33"), sql: sgr("36"), faint: sgr("2"), ok: sgr("32"), bad: sgr("31"), warn: sgr("1;33") };

const MB_DATABASE = 87; // "Snowflake Postgres" in metabase.data-eng.fresha.io
const SCHEMA = "ACCOUNTING_DOCUMENTS";
const T = {
  doc: `${SCHEMA}.PUBLIC_ACCOUNTING_DOCUMENTS`,
  config: `${SCHEMA}.PUBLIC_ACCOUNT_CONFIGURATIONS`,
  plugin: `${SCHEMA}.PUBLIC_ACCOUNT_CONFIGURATION_PLUGINS`,
  tracker: `${SCHEMA}.PUBLIC_E_INVOICE_TRACKERS`,
  error: `${SCHEMA}.PUBLIC_ACCOUNTING_DOCUMENT_ERROR_LOGS`,
  compliance: `${SCHEMA}.PUBLIC_E_INVOICE_COMPLIANCE_RECORDS`,
  log: `${SCHEMA}.PUBLIC_ACCOUNTING_DOCUMENTS_LOGS`,
};
const COUNTRY = "SA";

// A tax ID is typed a dozen ways — "SA 3020 7712 0700 003", "302077120700003" — and
// they all mean the same registration. Compare on the digits and letters alone, and
// let a code match whether or not the country is in front of it.
function taxKey(v) {
  return String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Exact, not a suffix: a shorter number is a different number, and matching it
// would quietly answer about the wrong supplier. A KSA supplier is known by its VAT
// number (15 digits) and by its CRN (10), and people hold either, so both count.
function taxMatches(want, row) {
  const w = taxKey(want).replace(/^SA(?=\d)/, "");
  if (!w) return true;
  return [row.TAX_ID, row.VAT_NUMBER, row.CONFIG_CRN, row.DOC_CRN].some((v) => taxKey(v).replace(/^SA(?=\d)/, "") === w);
}

function supplierKey(s) {
  return taxKey(s.supplier.tax_id || s.supplier.crn) || `config ${s.configuration_id}`;
}

// Where the document is, in the words the service itself uses to decide
// (EInvoiceStatus.from_tracker in app-accounting-documents): ZATCA's verdict wins
// whenever it has given one, then an upload Comarch refused outright, and anything
// else is still on its way — failed_to_send included, since it is retried.
function classify(r) {
  if (r.DELETED_AT) return { status: "voided", says: "deleted in Fresha" };
  if (!r.TRACKER_ID) return { status: "unknown", says: "no tracker — it was never queued to send" };
  const up = String(r.UPLOAD_STATUS || "").toLowerCase();
  const rev = String(r.REVIEW_STATUS || "").toLowerCase();
  if (rev === "approved") return { status: "ok", says: "approved by ZATCA" };
  if (rev === "approved_with_warnings") return { status: "ok", says: "approved by ZATCA, with warnings" };
  if (rev === "rejected") return { status: "error", says: "rejected by ZATCA" };
  if (rev === "failed") return { status: "error", says: up === "rejected" ? "refused by Comarch — ZATCA never saw it" : "failed after it was sent" };
  if (up === "rejected") return { status: "error", says: "refused by Comarch — ZATCA never saw it" };
  if (rev === "corrected") return { status: "pending", says: "superseded by a retry" };
  if (up === "not_started") return { status: "pending", says: "never uploaded" };
  if (up === "ready_to_send") return { status: "pending", says: "queued to send" };
  if (up === "sending_in_progress") return { status: "pending", says: "being sent to Comarch" };
  if (up === "failed_to_send") return { status: "pending", says: "failed to send — retried automatically" };
  if (up === "sent") return { status: "pending", says: "with ZATCA, waiting for its verdict" };
  return { status: "unknown", says: `upload ${up || "?"}, review ${rev || "?"}` };
}

const MARK = { ok: "✓", pending: "…", error: "✗", voided: "⊘", unknown: "?" };

function paint(kind, text) {
  if (kind === "ok") return c.ok(text);
  if (kind === "error") return c.bad(text);
  if (kind === "pending") return c.sql(text);
  if (kind === "voided") return c.faint(text);
  return c.warn(text);
}

function usage() {
  return `lookup_sa_zatca_document — find a KSA invoice or credit note and say where it is on its way to ZATCA

Usage:
  lookup_sa_zatca_document [flags] <RECEIPT>
  lookup_sa_zatca_document [flags] --document ID
  lookup_sa_zatca_document [flags] --web-doc ID

Arguments:
  RECEIPT                the number printed on the document (IRN…). Asked for on a
                         terminal when left out.

Flags:
  -t, --tax-id CODE      only the supplier with this VAT number or CRN, with or
                         without SA in front. Asked for on a terminal when left out;
                         answer nothing and matches from more than one supplier are
                         shown in a section each. A receipt number is only unique
                         within a supplier — some repeat fifty times over.
  -c, --config N         only this account configuration — its id or its plugin id,
                         whichever your sheet carries
  -d, --document ID      look up one accounting document by its id instead
  -w, --web-doc ID       look up the document Comarch knows by this WebDocId
  -l, --limit N          how many documents to report (default 20). It caps what is
                         shown, never what is counted
      --history          show each document's log and every tracker, even when
                         more than one document is shown (the default for one)
      --mb-database N    Metabase database id to query (default ${MB_DATABASE})
      --json             emit JSON instead of a report; never prompts
  -h, --help             show this help

Reads Snowflake Postgres through the Metabase CLI: \`mb auth login\` once.

Exit codes: 0 found and nothing shown is in an error state, 1 nothing was found or
something shown is in one, 2 the call was wrong or the Metabase CLI could not answer.
`;
}

function parseArgs(argv) {
  const o = { taxId: null, config: null, document: null, webDoc: null, limit: 20, history: false, mbDatabase: MB_DATABASE, json: false, positional: [] };
  const num = (flag, v) => {
    if (!/^\d+$/.test(String(v || ""))) fail(`${flag} takes a whole number, got ${v === undefined ? "nothing" : JSON.stringify(v)}`, 2);
    return Number(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { process.stdout.write(usage()); process.exit(0); }
    else if (a === "-t" || a === "--tax-id") o.taxId = argv[++i];
    else if (a === "-c" || a === "--config") o.config = num(a, argv[++i]);
    else if (a === "-d" || a === "--document") o.document = num(a, argv[++i]);
    else if (a === "-w" || a === "--web-doc") o.webDoc = num(a, argv[++i]);
    else if (a === "-l" || a === "--limit") o.limit = num(a, argv[++i]);
    else if (a === "--history") o.history = true;
    else if (a === "--mb-database") o.mbDatabase = num(a, argv[++i]);
    else if (a === "--json") o.json = true;
    else if (a.startsWith("-")) fail(`unknown flag: ${a}`, 2);
    else o.positional.push(a);
  }
  if (o.positional.length > 1) fail(`expected one receipt, got ${o.positional.length}: ${o.positional.join(" ")}`, 2);
  const ways = [o.positional.length > 0, o.document !== null, o.webDoc !== null].filter(Boolean).length;
  if (ways > 1) fail("give a receipt number, --document or --web-doc — one of them", 2);
  if (o.limit < 1) fail("--limit must be 1 or more", 2);
  return o;
}

function fail(message, code) {
  process.stderr.write(`${c.bad("error:")} ${message}\n`);
  process.exit(code);
}

// One readline interface for the whole process, per the house rule: opening and
// closing one per question loses the queued answers on a piped stdin.
let RL = null;
function lines() {
  if (!RL) RL = readlinePromises.createInterface({ input: process.stdin, output: process.stderr });
  return RL;
}
function closeLines() {
  if (RL) RL.close();
  RL = null;
}

// Ask for what was not passed. Never on a piped stdin and never under --json: a
// script that blocks on a question no one can answer is worse than one that fails.
async function askMissing(opts) {
  if (opts.json || !process.stdin.isTTY) return;
  if (opts.document !== null || opts.webDoc !== null) return;
  try {
    if (!opts.positional.length) {
      const typed = (await lines().question("Receipt number (as printed on the document, IRN…): ")).trim();
      if (typed) opts.positional.push(typed);
    }
    if (opts.taxId === null && opts.config === null && opts.positional.length) {
      const typed = (await lines().question("Supplier VAT number or CRN (Enter to see every supplier that matches): ")).trim();
      if (typed) opts.taxId = typed;
    }
  } finally {
    closeLines();
  }
}

function sqlQuote(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

// The documents, with everything that decides whose they are and where they are.
// Not narrowed to SA in SQL: a number that exists only in another country is worth
// saying so about, and the rows are few enough to split here.
function documentsSql(opts) {
  let where;
  if (opts.document !== null) where = `d.ID = ${opts.document}`;
  else if (opts.webDoc !== null) where = `d.ID IN (SELECT x.ACCOUNTING_DOCUMENT_ID FROM ${T.tracker} x WHERE x.WEB_DOC_ID = ${sqlQuote(opts.webDoc)})`;
  else where = `UPPER(TRIM(d.RECEIPT_NUMBER)) = ${sqlQuote(String(opts.positional[0]).trim().toUpperCase())}`;
  // The sheets people work from carry either id, and they are one apart in a way
  // that invites the wrong one, so both are accepted and either may match.
  const narrow = opts.config !== null ? `  AND (d.ACCOUNT_CONFIGURATION_ID = ${opts.config} OR d.ACCOUNT_CONFIGURATION_PLUGIN_ID = ${opts.config})` : "";
  return [
    "SELECT d.ID AS DOCUMENT_ID, d.RECEIPT_NUMBER, d.DOCUMENT_TYPE, d.PROVIDER_ID, d.SALE_ID_64,",
    "       d.EINVOICE_REFERENCE, d.COMPANY_REGISTRATION_NUMBER AS DOC_CRN,",
    "       d.ACCOUNT_CONFIGURATION_ID, d.ACCOUNT_CONFIGURATION_PLUGIN_ID, d.CREATED_AT, d.DELETED_AT,",
    "       COALESCE(p.COUNTRY_CODE, c.COUNTRY_CODE) AS COUNTRY_CODE,",
    "       c.TAX_ID, c.VAT_NUMBER, c.COMPANY_REGISTRATION_NUMBER AS CONFIG_CRN,",
    "       p.INTEGRATOR, p.INTEGRATION,",
    "       t.ID AS TRACKER_ID, t.UPLOAD_STATUS, t.REVIEW_STATUS, t.WEB_DOC_ID,",
    "       t.UPDATED_AT AS TRACKER_UPDATED_AT, t.INVALIDATED_AT",
    `FROM ${T.doc} d`,
    `LEFT JOIN ${T.config} c ON c.ID = d.ACCOUNT_CONFIGURATION_ID`,
    `LEFT JOIN ${T.plugin} p ON p.ID = d.ACCOUNT_CONFIGURATION_PLUGIN_ID`,
    `LEFT JOIN ${T.tracker} t ON t.ID = d.LATEST_TRACKER_ID`,
    `WHERE ${where}`,
    narrow,
    "ORDER BY d.ID",
  ]
    .filter(Boolean)
    .join("\n");
}

// Everything else about those documents in one round trip: one row shape, a KIND
// to tell them apart. Snowflake's replica of a jsonb column is a VARIANT, hence
// TO_VARCHAR.
function detailsSql(ids) {
  const list = ids.map(Number).join(", ");
  return [
    "SELECT ACCOUNTING_DOCUMENT_ID AS DOCUMENT_ID, 'tracker' AS KIND, ID, CREATED_AT AS AT,",
    "       UPLOAD_STATUS AS A, REVIEW_STATUS AS B, WEB_DOC_ID AS C",
    `FROM ${T.tracker} WHERE ACCOUNTING_DOCUMENT_ID IN (${list})`,
    "UNION ALL",
    "SELECT ACCOUNTING_DOCUMENT_ID, 'error', ID, CREATED_AT, TO_VARCHAR(RAW_ERROR), NULL, NULL",
    `FROM ${T.error} WHERE ACCOUNTING_DOCUMENT_ID IN (${list})`,
    "UNION ALL",
    "SELECT ACCOUNTING_DOCUMENT_ID, 'compliance', ID, CREATED_AT, TO_VARCHAR(DELETED_AT), NULL, EXTERNAL_INVOICE_REFERENCE",
    `FROM ${T.compliance} WHERE ACCOUNTING_DOCUMENT_ID IN (${list})`,
    "UNION ALL",
    "SELECT ACCOUNTING_DOCUMENT_ID, 'log', ID, CREATED_AT, LOG_TYPE, TO_VARCHAR(METADATA), NULL",
    `FROM ${T.log} WHERE ACCOUNTING_DOCUMENT_ID IN (${list})`,
    "ORDER BY DOCUMENT_ID, AT, ID",
  ].join("\n");
}

// `mb` is the Metabase CLI (`mb auth login` once). It is the only source this
// script has, so a missing or logged-out one is the call being wrong: exit 2.
function mbQuery(database, sql) {
  const body = JSON.stringify({ database, type: "native", native: { query: sql } });
  const file = path.join(os.tmpdir(), `lookup-zatca-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, body);
  try {
    const r = spawnSync("mb", ["query", "--file", file, "--json", "--max-bytes", "0"], { encoding: "utf8", timeout: 120000 });
    if (r.error) fail(r.error.code === "ENOENT" ? "the Metabase CLI (mb) is not on PATH — install it and run `mb auth login`" : `mb: ${r.error.message}`, 2);
    let out = null;
    try {
      out = JSON.parse(r.stdout || "{}");
    } catch {
      fail(`mb returned something that is not JSON: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}`, 2);
    }
    if (out?.ok === false || out?.error) fail(`mb: ${out?.error?.message || "reported an error"}`, 2);
    if (!out?.data?.cols) fail("mb returned no result set — is it logged in? (mb auth status)", 2);
    const cols = out.data.cols.map((col) => col.name);
    return (out.data.rows || []).map((row) => Object.fromEntries(cols.map((col, i) => [col, row[i]])));
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      /* it was a temp file either way */
    }
  }
}

function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// raw_error is Comarch's /api/status/error answer, verbatim. Its details come in
// two shapes: a mapping failure lists business rules (ErrorCode + ErrorDescription),
// and "Document already sent." names the original instead (DocumentNumber,
// OriginalTimeStamp). Anything else is kept as whatever text it has.
function parseError(raw) {
  const e = parseJson(raw) || {};
  const details = (Array.isArray(e.ErrorDetails) ? e.ErrorDetails : []).map((d) => {
    if (d?.ErrorCode || d?.ErrorDescription) {
      return { code: String(d.ErrorCode || "").trim() || null, message: String(d.ErrorDescription || "").trim() || null, field: String(d.InputDocumentFieldName || "").trim() || null };
    }
    if (d?.DocumentNumber) {
      return { code: null, message: `original ${d.DocumentNumber}${d.OriginalTimeStamp ? ` sent ${d.OriginalTimeStamp}` : ""}${d.SellerTaxId ? ` by ${d.SellerTaxId}` : ""}`, field: null };
    }
    return { code: null, message: JSON.stringify(d), field: null };
  });
  return { description: String(e.ErrorDescription || "").trim() || (e && Object.keys(e).length ? null : String(raw || "").slice(0, 200)), web_doc_id: e.WebDocId ?? null, details };
}

function summarise(r, details) {
  const mine = details.filter((x) => Number(x.DOCUMENT_ID) === Number(r.DOCUMENT_ID));
  const { status, says } = classify(r);
  const compliance = mine
    .filter((x) => x.KIND === "compliance")
    .map((x) => ({ id: x.ID, created_at: x.AT, deleted_at: x.A || null, external_reference: x.C || null }));
  return {
    document_id: r.DOCUMENT_ID,
    receipt_number: r.RECEIPT_NUMBER,
    document_type: r.DOCUMENT_TYPE,
    country: r.COUNTRY_CODE,
    integrator: r.INTEGRATOR,
    integration: r.INTEGRATION,
    status,
    says,
    issued_at: r.CREATED_AT,
    deleted_at: r.DELETED_AT,
    provider_id: r.PROVIDER_ID,
    sale_id: r.SALE_ID_64,
    einvoice_reference: r.EINVOICE_REFERENCE,
    configuration_id: r.ACCOUNT_CONFIGURATION_ID,
    plugin_id: r.ACCOUNT_CONFIGURATION_PLUGIN_ID,
    supplier: { tax_id: r.TAX_ID || r.VAT_NUMBER || null, crn: r.CONFIG_CRN || r.DOC_CRN || null },
    tracker: r.TRACKER_ID
      ? { id: r.TRACKER_ID, control_number: r.TRACKER_ID, upload_status: r.UPLOAD_STATUS, review_status: r.REVIEW_STATUS, web_doc_id: r.WEB_DOC_ID, updated_at: r.TRACKER_UPDATED_AT, invalidated_at: r.INVALIDATED_AT }
      : null,
    trackers: mine.filter((x) => x.KIND === "tracker").map((x) => ({ id: x.ID, created_at: x.AT, upload_status: x.A, review_status: x.B, web_doc_id: x.C })),
    errors: mine.filter((x) => x.KIND === "error").map((x) => ({ id: x.ID, created_at: x.AT, ...parseError(x.A) })),
    compliance,
    qr: compliance.some((x) => !x.deleted_at),
    history: mine.filter((x) => x.KIND === "log").map((x) => ({ at: x.AT, type: x.A, metadata: parseJson(x.B) ?? x.B ?? null })),
  };
}

const when = (v) => (v ? String(v).replace("T", " ").replace(/:\d\dZ?$/, "").replace(/Z$/, "") : "—");

function report(s, pad, withSupplier, full) {
  const out = [];
  const type = s.document_type === "credit_note" ? "credit note" : s.document_type || "document";
  out.push(`${pad}${paint(s.status, MARK[s.status])} ${c.header(s.receipt_number || "(no number)")}  ${type}  ${paint(s.status, s.says)}`);
  const row = (k, v) => out.push(`${pad}    ${c.faint(k.padEnd(12))} ${v}`);
  row("Document", `${c.header(String(s.document_id))}${c.faint(`  · issued ${when(s.issued_at)}`)}${s.deleted_at ? c.bad(`  · deleted ${when(s.deleted_at)}`) : ""}`);
  if (withSupplier && (s.supplier.tax_id || s.supplier.crn)) {
    row("Supplier", [s.supplier.tax_id && c.header(s.supplier.tax_id), s.supplier.crn && c.faint(`CRN ${s.supplier.crn}`)].filter(Boolean).join("  ·  "));
  }
  row("Config", `${s.configuration_id}${s.plugin_id ? c.faint(`  · plugin ${s.plugin_id}`) : ""}${s.integrator ? c.faint(`  · ${s.integrator}`) : ""}${s.provider_id ? c.faint(`  · provider ${s.provider_id}`) : ""}`);
  if (s.sale_id) row("Sale", String(s.sale_id));
  if (s.tracker) {
    const t = s.tracker;
    row("Tracker", `${t.id}  upload ${c.header(String(t.upload_status))}  ·  review ${c.header(String(t.review_status))}${c.faint(`  · ${when(t.updated_at)}`)}`);
    if (t.web_doc_id) row("Comarch", `WebDocId ${t.web_doc_id}  ${c.faint(`· ControlNumber ${t.id}`)}`);
    if (t.invalidated_at) row("", c.warn(`invalidated ${when(t.invalidated_at)}`));
    if (s.trackers.length > 1) row("Attempts", `${s.trackers.length} trackers${full ? "" : c.faint("  (--history lists them)")}`);
  }
  if (s.qr) {
    const live = s.compliance.filter((x) => !x.deleted_at).slice(-1)[0];
    row("ZATCA", `${c.ok("QR stored")}${c.faint(`  · ${when(live.created_at)}`)}`);
  } else if (s.status === "ok") {
    // Approved but nothing stored: the APERAK has not been matched to it yet, or
    // was filed as unmatched. Either way the customer has no QR on their copy.
    row("ZATCA", c.warn("approved, but no QR stored — the APERAK has not been matched to this document"));
  }
  // The latest error is the one that matters; older ones are history.
  const errs = full ? s.errors : s.errors.slice(-1);
  for (const e of errs) {
    row("Error", `${c.bad(e.description || "Comarch gave no reason")}${c.faint(`  · ${when(e.created_at)}`)}`);
    for (const d of e.details) row("", `${d.code ? c.bad(d.code) + " " : ""}${d.message || ""}`);
  }
  if (!full && s.errors.length > 1) row("", c.faint(`${s.errors.length - 1} earlier error(s) — --history lists them`));
  if (full) {
    if (s.trackers.length > 1) {
      for (const t of s.trackers) row("Tracker", `${t.id}  ${t.upload_status} / ${t.review_status}${t.web_doc_id ? `  · WebDocId ${t.web_doc_id}` : ""}${c.faint(`  · ${when(t.created_at)}`)}`);
    }
    if (s.history.length) out.push(`${pad}    ${c.faint("History")}`);
    for (const h of foldHistory(s.history)) {
      const span = h.count > 1 ? c.faint(`  ×${h.count}, until ${when(h.last)}`) : "";
      const meta = h.metadata && typeof h.metadata === "object" && Object.keys(h.metadata).length ? c.faint(`  ${JSON.stringify(h.metadata).slice(0, 120)}`) : "";
      out.push(`${pad}      ${c.faint(when(h.at))}  ${h.label}${span}${meta}`);
    }
  }
  return out.join("\n");
}

// The log writes every status change twice — `…_updated`, then `…_confirmed` once
// Comarch has been told — and a document Comarch keeps re-reporting repeats that
// pair every few minutes for hours. Folded, a hundred lines become the three or
// four things that happened: a confirmation joins the update it confirms, and a
// run of the same event is one line with its count and its last time.
function foldHistory(history) {
  const paired = [];
  for (const h of history) {
    const prev = paired[paired.length - 1];
    const base = String(h.type || "").replace(/_confirmed$/, "_updated");
    if (prev && h.type !== base && prev.type === base && !prev.confirmed && when(prev.at) === when(h.at)) {
      prev.confirmed = true;
      continue;
    }
    paired.push({ ...h, confirmed: false });
  }
  const folded = [];
  for (const h of paired) {
    const label = `${h.type}${h.confirmed ? c.faint(" + confirmed") : ""}`;
    const prev = folded[folded.length - 1];
    if (prev && prev.label === label && !h.metadata && !prev.metadata) {
      prev.count += 1;
      prev.last = h.at;
      continue;
    }
    folded.push({ at: h.at, last: h.at, label, count: 1, metadata: h.metadata });
  }
  return folded;
}

// A few documents get a report each. Past that — and a receipt number repeats
// across dozens of suppliers — a report each is a wall, so they become one row
// each, the ones in trouble first, and the report is one --tax-id or --document away.
const REPORTS_UP_TO = 3;
const RANK = { error: 0, unknown: 1, pending: 2, voided: 3, ok: 4 };

function tally(found) {
  const n = {};
  for (const s of found) n[s.status] = (n[s.status] || 0) + 1;
  return ["error", "pending", "unknown", "voided", "ok"].filter((k) => n[k]).map((k) => paint(k, `${n[k]} ${k}`)).join(c.faint(" · "));
}

function table(found, limit) {
  const shown = [...found].sort((a, b) => RANK[a.status] - RANK[b.status] || Number(a.document_id) - Number(b.document_id)).slice(0, limit);
  const cols = [
    { head: "", get: (s) => MARK[s.status], paint: (s, v) => paint(s.status, v) },
    { head: "SUPPLIER", get: (s) => s.supplier.tax_id || "—", paint: (s, v) => c.header(v) },
    { head: "CRN", get: (s) => s.supplier.crn || "—" },
    { head: "CONFIG", get: (s) => String(s.configuration_id ?? "—") },
    { head: "DOCUMENT", get: (s) => String(s.document_id) },
    { head: "TYPE", get: (s) => (s.document_type === "credit_note" ? "credit" : s.document_type || "—") },
    { head: "ISSUED", get: (s) => when(s.issued_at).slice(0, 10) },
    { head: "WHERE IT IS", get: (s) => s.says, paint: (s, v) => paint(s.status, v), last: true },
  ];
  const width = cols.map((col) => Math.max(col.head.length, ...shown.map((s) => col.get(s).length)));
  const line = (cells) => cells.join("  ").trimEnd();
  const out = [c.faint(line(cols.map((col, i) => (col.last ? col.head : col.head.padEnd(width[i])))))];
  for (const s of shown) {
    out.push(line(cols.map((col, i) => {
      const v = col.get(s);
      const padded = col.last ? v : v.padEnd(width[i]);
      return col.paint ? col.paint(s, padded) : padded;
    })));
  }
  return out.join("\n");
}

function render(found, opts) {
  const suppliers = new Set(found.map(supplierKey)).size;
  const full = opts.history || found.length === 1;
  const head = found.length > 1 ? `${c.faint(`${found.length} documents${suppliers > 1 ? `, from ${suppliers} suppliers` : ""}:`)} ${tally(found)}\n\n` : "";
  if (full || found.length <= REPORTS_UP_TO) {
    const shown = found.slice(0, opts.limit);
    return head + shown.map((s) => report(s, "", true, full)).join("\n\n") + (shown.length < found.length ? c.faint(`\n\n${found.length - shown.length} more — raise --limit`) : "");
  }
  const more = found.length > opts.limit ? c.faint(`\n${found.length - opts.limit} more — raise --limit`) : "";
  const hint = suppliers > 1 ? "--tax-id picks one supplier" : "--history reports every one";
  return head + table(found, opts.limit) + more + c.faint(`\n\n--document ID reports one in full · ${hint}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await askMissing(opts);
  if (!opts.positional.length && opts.document === null && opts.webDoc === null) {
    fail("no receipt given — pass the number printed on the document, or --document / --web-doc", 2);
  }
  const asked = opts.document !== null ? `document ${opts.document}` : opts.webDoc !== null ? `WebDocId ${opts.webDoc}` : opts.positional[0];

  if (!opts.json) process.stderr.write(c.faint(`Reading Snowflake Postgres through the Metabase CLI…\n`));
  const rows = mbQuery(opts.mbDatabase, documentsSql(opts));
  const sa = rows.filter((r) => String(r.COUNTRY_CODE || "").toUpperCase() === COUNTRY);
  const elsewhere = rows.filter((r) => String(r.COUNTRY_CODE || "").toUpperCase() !== COUNTRY);
  // A receipt number is only unique within a supplier, so the same number can come
  // back for several. --tax-id picks one; without it they are shown apart.
  const kept = opts.taxId ? sa.filter((r) => taxMatches(opts.taxId, r)) : sa;

  const details = kept.length ? mbQuery(opts.mbDatabase, detailsSql(kept.map((r) => r.DOCUMENT_ID))) : [];
  const found = kept.map((r) => summarise(r, details));

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          receipt: opts.positional[0] ?? null,
          document_id: opts.document,
          web_doc_id: opts.webDoc,
          tax_id: opts.taxId,
          config: opts.config,
          count: found.length,
          other_countries: [...new Set(elsewhere.map((r) => r.COUNTRY_CODE).filter(Boolean))],
          documents: found,
        },
        null,
        2
      ) + "\n"
    );
  } else if (!found.length) {
    process.stdout.write(`${c.warn("?")} no KSA document matches ${c.header(asked)}${opts.taxId ? ` for ${c.header(opts.taxId)}` : ""}${opts.config !== null ? ` in configuration ${opts.config}` : ""}\n`);
    if (opts.taxId && sa.length) {
      // Being told the number exists, just not for that supplier, is the answer
      // nine times out of ten when a tax ID was given.
      const others = [...new Set(sa.map((r) => r.TAX_ID || r.VAT_NUMBER || r.CONFIG_CRN).filter(Boolean))];
      process.stdout.write(c.faint(`    ${sa.length} document(s) do carry that number, for ${others.length} other supplier(s)${others.length <= 6 ? `: ${others.join(", ")}` : ""}.\n`));
    }
    if (elsewhere.length) {
      const where = [...new Set(elsewhere.map((r) => r.COUNTRY_CODE || "no country"))];
      process.stdout.write(c.faint(`    ${elsewhere.length} document(s) with it exist outside KSA (${where.join(", ")}) — not this script's to answer.\n`));
    }
    if (!sa.length && !elsewhere.length) {
      process.stdout.write(c.faint(`    Receipt numbers are matched exactly (case aside) — IRN0167336, not 0167336.\n    The replica trails production by a few minutes; a document issued just now may not be here yet.\n`));
    }
  } else {
    process.stdout.write(render(found, opts) + "\n");
    // The replica trails production. When something is still moving, say so, so a
    // verdict that arrived a minute ago is not mistaken for one that never came.
    if (found.some((s) => s.status === "pending")) {
      process.stdout.write(c.faint(`\n    Snowflake trails production by a few minutes — a verdict from just now may not be here yet.\n`));
    }
  }

  // 1 means the data is wrong: nothing found, or what was found is in an error
  // state. A document still on its way is not a problem yet, so it stays 0.
  const bad = !found.length || found.some((s) => s.status === "error");
  process.exit(bad ? 1 : 0);
}

main().catch((err) => fail(err.stack || err.message, 2));
