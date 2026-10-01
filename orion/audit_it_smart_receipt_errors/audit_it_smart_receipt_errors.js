#!/usr/bin/env node
"use strict";

// audit_it_smart_receipt_errors — table every IT invoice and credit note stuck in an error state, and aggregate why.
//
// Self-contained on purpose: one directory, one entrypoint, no shared library.
// Copy helpers from a sibling script rather than importing them — most of what is
// here came from lookup_invopop_document, which answers the same question about
// one receipt instead of all of them.
//
// Transport: Invopop REST API (https://api.invopop.com), global fetch. No houston.
// Auth: Bearer token from SMART_RECEIPTS_READ_ONLY_API_TOKEN, else a paste prompt with
//       the echo off.
//       The token decides the workspace, and therefore the country and integration —
//       the workspace is printed first so you can see you asked the right one.
//
// Read-only: three GETs, no writes anywhere, nothing to dry-run.
//   1. GET /access/v1/workspace     — whose workspace this token opens
//   2. GET /silo/v1/entries?…       — the silo, newest first, one page at a time
//   3. GET /silo/v1/entries/{id}    — the errored ones again, for what the list omits
//
// The silo has no "state" filter, so the sweep is a scan: every entry inside the
// window is read and the errored ones are kept. That is what --since is for —
// it bounds the scan, not just the report. A listed entry carries neither its
// envelope nor its faults whatever the API reference says, so the errored ones are
// fetched a second time — see `hydrate`.

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { header: sgr("1;37"), cmd: sgr("33"), sql: sgr("36"), faint: sgr("2"), ok: sgr("32"), bad: sgr("31"), warn: sgr("1;33") };

const DEFAULT_BASE_URL = "https://api.invopop.com";
const TOKEN_ENV = "SMART_RECEIPTS_READ_ONLY_API_TOKEN";
const TIMEOUT_MS = 20000;

// The console's own address for a silo entry:
//   https://console.invopop.com/<workspace slug>/silo/<folder>/<entry id>
// The slug comes from /access/v1/workspace, the folder from the entry itself, so
// the link is built from what the API already answered rather than assumed. An
// errored entry carries no `link_url` of its own — no meta rows at all until AdE
// accepts it — so this is the only way to get from the table to the document.
const DEFAULT_CONSOLE_URL = "https://console.invopop.com";

function consoleUrl(base, workspace, row) {
  const slug = workspace?.slug;
  if (!slug || !row?.folder || !row?.id) return null;
  return `${String(base).replace(/\/+$/, "")}/${slug}/silo/${row.folder}/${row.id}`;
}

// A terminal that understands OSC 8 shows the id and follows the link on a click;
// one that does not shows the id and ignores the rest. Piped output gets neither —
// stdout is data there, and an escape sequence in a column is not data.
const LINKS = process.stdout.isTTY;

function hyperlink(text, url) {
  return LINKS && url ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text;
}

// Fresha's own ids for the same receipts, read through the Metabase CLI. Invopop
// knows the document; only Fresha knows which accounting document, which tracker
// and which sale it came from, and those are the ids a retry is driven by.
const MB_DATABASE = 87; // "Snowflake Postgres" in metabase.data-eng.fresha.io
const DOC_TABLE = "ACCOUNTING_DOCUMENTS.PUBLIC_ACCOUNTING_DOCUMENTS";
const TRACKER_TABLE = "ACCOUNTING_DOCUMENTS.PUBLIC_E_INVOICE_TRACKERS";
const CONFIG_TABLE = "ACCOUNTING_DOCUMENTS.PUBLIC_ACCOUNT_CONFIGURATIONS";
// One query covers the whole table, but a receipt number is reused across
// suppliers and countries, so each one is asked for with its tax ID beside it and
// the clause count is what grows. Past this many the lookup is skipped rather than
// sent as a query nobody wants to read.
const MB_MAX_CLAUSES = 200;

// The silo answers at most 100 entries a page and hands back a next_cursor. It has
// kept handing one back after the last page before now, so a page that repeats its
// cursor, or returns only entries already seen, is the end of the list.
const PAGE = 100;
const DEFAULT_SCAN = 5000;
const DEFAULT_SINCE = "7d";

// Asked for one folder, the silo answers in descending creation order. Asked for
// every folder, it answers one folder's list after another's — 54 suppliers back to
// June, then 46 invoices from today — so the whole is not in creation order at all
// and "older than the window" stops meaning "and so is everything after it". The
// default is therefore the folder the receipts are actually in; `--folder all`
// reads the lot and gives up the early stop for it.
const DEFAULT_FOLDER = "invoices";

// A Smart Receipt is a GOBL bill/invoice, and so is a credit note — the two differ
// by the document's `type`, not by where they are filed. Filtering on the schema is
// therefore what separates the receipts from the parties the silo also holds, and
// it is the filter the script actually applies; the folder only narrows how much
// has to be read to find them.
const DOC_SCHEMA_RE = /\/bill\/invoice$/;

// An entry that failed early enough may never have been given a schema, and those
// are exactly the ones this script exists to find — dropping them would hide the
// worst failures behind a missing field. So a schema-less entry shaped like a
// receipt (it has a number, lines, or a supplier) is kept, while one that names
// some other schema is not.
function isReceiptDoc(entry) {
  const schema = String(entry?.doc_schema || "");
  if (schema) return DOC_SCHEMA_RE.test(schema);
  const doc = entry?.data?.doc || entry?.data || entry?.snippet || {};
  return Boolean(doc?.code || doc?.series || doc?.lines || doc?.supplier);
}

// GOBL invoice types. Smart Receipts refunds are issued as corrective invoices, so
// both of those land on the credit-note side of the table: they are the documents
// that take money back rather than charge it.
const CREDIT_TYPES = ["credit-note", "corrective", "debit-note"];

// ---------------------------------------------------------------------------
// States, the same buckets check_invopop_suppliers and lookup_invopop_document use,
// so a state means the same thing whichever script shows it to you.
// ---------------------------------------------------------------------------

const OK_STATES = ["registered", "completed", "sent", "received", "paid", "accepted", "done"];
const PENDING_STATES = ["draft", "processing", "pending", "queued", "waiting"];
const ERROR_STATES = ["error", "rejected", "invalid"];
const VOIDED_STATES = ["void", "voided", "cancelled", "canceled"];

const MARK = { ok: "✓", pending: "…", error: "✗", voided: "⊘", unknown: "?" };

function classify(state) {
  const s = String(state || "").toLowerCase();
  if (OK_STATES.includes(s)) return "ok";
  if (PENDING_STATES.includes(s)) return "pending";
  if (ERROR_STATES.includes(s)) return "error";
  if (VOIDED_STATES.includes(s)) return "voided";
  return "unknown";
}

function paint(kind, text) {
  if (kind === "ok") return c.ok(text);
  if (kind === "error") return c.bad(text);
  if (kind === "pending") return c.sql(text);
  if (kind === "voided") return c.faint(text);
  return c.warn(text);
}

// ---------------------------------------------------------------------------
// Tax IDs — GOBL keeps the country in its own field, but it is routinely typed into
// the code as well ("IT04042660921" alongside country "IT"). Left alone that prints
// as "IT IT04042660921" and files one supplier under two names in the same table.
// ---------------------------------------------------------------------------

function normaliseTax(tax) {
  let country = String(tax?.country || "").trim().toUpperCase() || null;
  let code = String(tax?.code || "").trim();
  const m = /^([A-Za-z]{2})[-\s]?(\S.*)$/.exec(code);
  if (m && /\d/.test(m[2]) && (!country || m[1].toUpperCase() === country)) {
    country = country || m[1].toUpperCase();
    code = m[2].trim();
  }
  return { country, code: code || null };
}

function taxLabel(tax) {
  const bits = [tax?.country, tax?.code].filter(Boolean);
  return bits.length ? bits.join(" ") : null;
}

function taxKey(v) {
  return String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Exact, not a suffix: "2660921" is not a shorter way of writing "04042660921", it
// is a different number, and matching it would quietly answer about the wrong
// supplier. Only the same registration written differently counts.
function taxMatches(want, tax) {
  const w = taxKey(want);
  if (!w) return true;
  return w === taxKey(`${tax?.country || ""}${tax?.code || ""}`) || w === taxKey(tax?.code);
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

function ui_warn(message) {
  process.stderr.write(`${c.warn("warning:")} ${message}\n`);
}

function usage() {
  return `audit_it_smart_receipt_errors — table the IT receipts and credit notes stuck in error, and aggregate why

Usage:
  audit_it_smart_receipt_errors [flags]

Flags:
      --since WINDOW     how far back to sweep: 24h, 7d, 3mo, an ISO date, or
                         "all" (default ${DEFAULT_SINCE}). It bounds the scan, not just the
                         report — the silo has no state filter, so everything
                         inside the window is read
  -f, --folder NAME      the silo folder to read (default ${DEFAULT_FOLDER}), or "all"
                         for every folder. Within a folder the silo answers in
                         creation order, so --since can stop the sweep early;
                         across folders it does not, and "all" reads to --scan.
                         What is kept is always and only a bill/invoice document
  -t, --type KIND        invoices, credit-notes, or all (default all)
      --tax-id CODE      only this supplier, with or without the country in front
      --state NAME       treat only this state as an error (repeatable). The
                         default is every one of: ${ERROR_STATES.join(", ")}
  -l, --limit N          how many rows to print (default 50). It caps the table,
                         never the scan or the aggregate — the counts are always
                         the true ones
      --scan N           stop after reading this many entries (default ${DEFAULT_SCAN}).
                         Reaching it is reported, never silent
      --no-db            skip Fresha's own rows. By default the errored receipts
                         are looked up in Snowflake Postgres through the Metabase
                         CLI for their accounting document id, latest tracker id
                         and sale_id_64 — the ids a retry is driven by. A missing
                         or logged-out \`mb\` is reported and stepped over
      --mb-database N    Metabase database id to query (default ${MB_DATABASE})
      --csv [PATH]       write the CSV and nothing else. With no PATH it goes to a
                         fresh directory under the system temp dir and the path is
                         printed on stderr; PATH may name a file or a directory.
                         "-" writes it to stdout instead, in place of the tables
      --report           also write a Markdown report and a CSV to the cwd
      --base-url URL     Invopop API base URL (default ${DEFAULT_BASE_URL})
      --console-url URL  Invopop console base, for the silo entry links
                         (default ${DEFAULT_CONSOLE_URL})
      --json             emit JSON instead of the report; never prompts
  -h, --help             show this help

The token comes from $${TOKEN_ENV}, and is asked for with the echo
off when that is unset. \`ops secrets set ${TOKEN_ENV}\` saves it
so the question is asked once.

Exit codes: 0 nothing in the window errored, 1 something did, 2 the call was wrong
or the token was refused.
`;
}

function parseArgs(argv) {
  const o = {
    since: DEFAULT_SINCE,
    folder: DEFAULT_FOLDER,
    type: "all",
    taxId: null,
    states: [],
    limit: 50,
    scan: DEFAULT_SCAN,
    db: true,
    mbDatabase: MB_DATABASE,
    csv: null, // null = not asked for; "" = temp dir; "-" = stdout; else a path
    report: false,
    baseUrl: process.env.INVOPOP_API_BASE_URL || DEFAULT_BASE_URL,
    consoleUrl: process.env.INVOPOP_CONSOLE_URL || DEFAULT_CONSOLE_URL,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { process.stdout.write(usage()); process.exit(0); }
    else if (a === "--since") o.since = argv[++i];
    else if (a === "-f" || a === "--folder") o.folder = String(argv[++i] || "").toLowerCase() === "all" ? null : argv[i];
    else if (a === "-t" || a === "--type") o.type = String(argv[++i] || "").toLowerCase();
    else if (a === "--tax-id") o.taxId = argv[++i];
    else if (a === "--state") o.states.push(String(argv[++i] || "").toLowerCase());
    else if (a === "-l" || a === "--limit") o.limit = Number(argv[++i]);
    else if (a === "--scan") o.scan = Number(argv[++i]);
    else if (a === "--db") o.db = true;
    else if (a === "--no-db") o.db = false;
    else if (a === "--mb-database") o.mbDatabase = Number(argv[++i]);
    // The path is optional, so the next argument is only taken when it is one —
    // `--csv --json` must not quietly write a file called "--json".
    else if (a === "--csv") o.csv = argv[i + 1] !== undefined && (argv[i + 1] === "-" || !argv[i + 1].startsWith("-")) ? argv[++i] : "";
    else if (a === "--report") o.report = true;
    else if (a === "--base-url") o.baseUrl = argv[++i];
    else if (a === "--console-url") o.consoleUrl = argv[++i];
    else if (a === "--json") o.json = true;
    else if (a.startsWith("-")) fail(`unknown flag: ${a}`, 2);
    else fail(`unexpected argument: ${a} — this script sweeps a window, it does not take a receipt number (see lookup_invopop_document --regime smart_receipts)`, 2);
  }
  const TYPES = { all: "all", invoice: "invoices", invoices: "invoices", "credit-note": "credit-notes", "credit-notes": "credit-notes", "credit_note": "credit-notes" };
  if (!TYPES[o.type]) fail(`--type must be one of invoices, credit-notes, all — not ${o.type}`, 2);
  o.type = TYPES[o.type];
  if (!Number.isInteger(o.limit) || o.limit < 1) fail("--limit must be a whole number, 1 or more", 2);
  if (!Number.isInteger(o.scan) || o.scan < 1) fail("--scan must be a whole number, 1 or more", 2);
  o.states = o.states.length ? o.states : ERROR_STATES.slice();
  o.cutoff = parseSince(o.since);
  return o;
}

// 24h, 7d, 3mo, 1y, an ISO date, or "all". Null means no floor.
function parseSince(since) {
  const s = String(since || "").trim().toLowerCase();
  if (!s || s === "all") return null;
  const m = /^(\d+)\s*(h|d|w|mo|m|y)$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    const ms = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, mo: 30 * 86400e3, m: 30 * 86400e3, y: 365 * 86400e3 }[m[2]];
    return new Date(Date.now() - n * ms);
  }
  const at = new Date(s);
  if (Number.isNaN(at.getTime())) fail(`--since ${since} is neither a window (24h, 7d, 3mo) nor a date`, 2);
  return at;
}

function fail(message, code) {
  process.stderr.write(`${c.bad("error:")} ${message}\n`);
  process.exit(code);
}

// One prompt, echo off, straight from the tty. Never on a piped stdin: a token read
// from a pipe would be a token in a file somewhere.
function askToken() {
  return new Promise((resolve) => {
    const { stdin, stderr } = process;
    if (!stdin.isTTY) return resolve(null);
    stderr.write(`Paste the Invopop API token (input hidden): `);
    let buf = "";
    const done = (v) => {
      stdin.setRawMode(false);
      stdin.removeListener("data", onData);
      stdin.pause();
      stderr.write("\n");
      resolve(v);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") return done(buf.trim() || null);
        if (ch === "\x03" || ch === "\x04") return done(null);
        if (ch === "\x7f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function resolveToken(json) {
  const fromEnv = (process.env[TOKEN_ENV] || "").trim();
  if (fromEnv) return fromEnv;
  if (json) fail(`$${TOKEN_ENV} is unset, and --json never prompts`, 2);
  if (!process.stdin.isTTY) fail(`$${TOKEN_ENV} is unset and there is no terminal to ask on`, 2);
  process.stderr.write(c.faint(`$${TOKEN_ENV} is not set.\n`));
  const typed = await askToken();
  if (!typed) fail("no token given", 2);
  return typed;
}

// ---------------------------------------------------------------------------
// The silo
// ---------------------------------------------------------------------------

async function api(baseUrl, token, endpoint, params) {
  const url = new URL(endpoint, baseUrl);
  for (const [k, v] of Object.entries(params || {})) if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    fail(`${url.pathname} — ${err.name === "TimeoutError" ? `no answer in ${TIMEOUT_MS / 1000}s` : err.message}`, 2);
  }
  const body = await res.text();
  let data = null;
  try {
    data = body ? JSON.parse(body) : null;
  } catch {
    /* not JSON: reported below with the status */
  }
  if (res.status === 401 || res.status === 403) fail(`the token was refused (${res.status}) — check it opens the right workspace`, 2);
  if (res.status === 404) return { missing: true };
  if (!res.ok) fail(`${url.pathname} returned ${res.status}${data?.message ? ` — ${data.message}` : ""}`, 2);
  return { data };
}

// Newest first within a folder, so the cutoff can be a stopping rule rather than
// only a filter. It takes a whole page older than the floor to stop, not the first
// old entry on one: across folders the silo concatenates lists instead of merging
// them, and one June supplier seventeen rows into today's page would otherwise end
// a seven-day sweep on its first request.
async function sweep(baseUrl, token, { folder, cutoff, scan }) {
  const list = [];
  const seen = new Set();
  let cursor = null;
  for (;;) {
    const got = await api(baseUrl, token, "/silo/v1/entries", { folder, limit: PAGE, cursor });
    const body = got.missing ? {} : got.data || {};
    const page = body.list || [];
    let fresh = 0;
    let kept = 0;
    for (const e of page) {
      if (!e?.id || seen.has(e.id)) continue;
      seen.add(e.id);
      fresh++;
      if (cutoff && e.created_at && new Date(e.created_at) < cutoff) continue;
      kept++;
      list.push(e);
    }
    // Every new entry on this page predates the window, so the pages behind it do
    // too — within a folder they are in creation order.
    if (cutoff && fresh > 0 && kept === 0) return { list, scanned: seen.size, truncated: false };
    if (seen.size >= scan) return { list, scanned: seen.size, truncated: true };
    const next = body.next_cursor || null;
    // The silo has been seen handing back a cursor past the end of the list, so a
    // repeated cursor and a page with nothing new on it both mean there is no more.
    // A page shorter than asked for does not: `limit` is a ceiling, and treating a
    // short page as the end would stop the sweep in the middle of the window.
    if (!next || next === cursor || fresh === 0) return { list, scanned: seen.size, truncated: false };
    cursor = next;
  }
}

// The API reference says an entry list includes `data` "when fetching … and in
// entry lists". It does not: a listed entry arrives with its snippet and no
// envelope and — the part that matters here — **no `faults`**. Taken at its word
// the sweep reported every failure as "(no fault recorded)", named no supplier, and
// filed every credit note as an invoice, because `type` lives in the envelope too.
// So the errored entries are fetched again by id, where all of it is present. That
// is one GET per errored document, run a few at a time, and the error count is what
// pays for it — not the size of the sweep.
const HYDRATE_CONCURRENCY = 8;

async function hydrate(baseUrl, token, entries) {
  const out = new Array(entries.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < entries.length; i = next++) {
      const e = entries[i];
      if (e?.data?.doc || !e?.id) {
        out[i] = e;
        continue;
      }
      const got = await api(baseUrl, token, `/silo/v1/entries/${e.id}`);
      out[i] = got.missing || !got.data ? e : { ...e, ...got.data };
    }
  };
  await Promise.all(Array.from({ length: Math.min(HYDRATE_CONCURRENCY, entries.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// Fresha's side: the accounting document, its latest tracker, and the sale
// ---------------------------------------------------------------------------

function sqlQuote(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

// The same tolerance the Invopop side uses, expressed in SQL: compare on letters
// and digits alone, and treat a code with its country in front as the same
// registration as one without — the warehouse stores it both ways, `IT02893930921`
// for one configuration and `09841880967` for the next. Exact, never a suffix.
function taxPredicate(taxId) {
  const k = taxKey(taxId);
  const bare = k.replace(/^[A-Z]{2}(?=\d)/, "");
  if (!bare) return null;
  const norm = (col) => `REGEXP_REPLACE(UPPER(COALESCE(${col}, '')), '[^A-Z0-9]', '')`;
  const country = "UPPER(COALESCE(c.COUNTRY_CODE, ''))";
  const one = (col) => `(${norm(col)} IN (${sqlQuote(k)}, ${sqlQuote(bare)}) OR ${norm(col)} = ${country} || ${sqlQuote(bare)})`;
  return `(${one("c.TAX_ID")} OR ${one("c.VAT_NUMBER")})`;
}

// RECEIPT_NUMBER holds the bare code — `INV01406`, not `FT-INV01406` — and the same
// code comes round again for other suppliers and other countries: `INV01166` alone
// answers for eight configurations across IT and ES. So every receipt is asked for
// as its code AND its supplier's tax ID, and a receipt whose document names no tax
// ID is left out rather than matched on the number alone.
function warehouseSql(pairs) {
  const clauses = pairs
    .map(({ code, tax }) => {
      const t = taxPredicate(tax);
      return t ? `(d.RECEIPT_NUMBER = ${sqlQuote(code)} AND ${t})` : null;
    })
    .filter(Boolean);
  if (!clauses.length) return null;
  return [
    "SELECT d.ID AS DOCUMENT_ID, d.RECEIPT_NUMBER, d.DOCUMENT_TYPE, d.SALE_ID_64,",
    "       d.LATEST_TRACKER_ID, d.ACCOUNT_CONFIGURATION_ID, d.CREATED_AT,",
    "       c.COUNTRY_CODE, c.TAX_ID, c.VAT_NUMBER,",
    "       t.UPLOAD_STATUS, t.REVIEW_STATUS, t.UPDATED_AT AS TRACKER_UPDATED_AT",
    `FROM ${DOC_TABLE} d`,
    `LEFT JOIN ${CONFIG_TABLE} c ON c.ID = d.ACCOUNT_CONFIGURATION_ID`,
    `LEFT JOIN ${TRACKER_TABLE} t ON t.ID = d.LATEST_TRACKER_ID`,
    `WHERE ${clauses.join("\n   OR ")}`,
    "ORDER BY d.ID DESC",
  ].join("\n");
}

// `mb` is the Metabase CLI (`mb auth login` once). A missing or unauthenticated CLI
// is reported and stepped over: the Invopop half of the table still stands, and an
// audit that refused to print anything because a second system was unreachable
// would be worse than one with three empty columns.
function warehouseLookup(pairs, database) {
  const sql = warehouseSql(pairs);
  if (!sql) return { rows: [] };
  const body = JSON.stringify({ database, type: "native", native: { query: sql } });
  const file = path.join(os.tmpdir(), `audit-it-receipts-${process.pid}.json`);
  fs.writeFileSync(file, body);
  try {
    const r = spawnSync("mb", ["query", "--file", file, "--json", "--max-bytes", "0"], { encoding: "utf8", timeout: 120000 });
    if (r.error) return { error: r.error.code === "ENOENT" ? "the Metabase CLI (mb) is not on PATH" : r.error.message };
    let out = null;
    try {
      out = JSON.parse(r.stdout || "{}");
    } catch {
      return { error: `mb returned something that is not JSON: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}` };
    }
    if (out?.ok === false || out?.error) return { error: out?.error?.message || "mb reported an error" };
    if (!out?.data?.cols) return { error: "mb returned no result set — is the profile logged in? (mb auth status)" };
    const cols = out.data.cols.map((x) => x.name);
    return { rows: (out.data.rows || []).map((row) => Object.fromEntries(cols.map((x, i) => [x, row[i]]))) };
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      /* it was a temp file either way */
    }
  }
}

// Newest first, so the first row for a (code, tax ID) is the current document. The
// number is reused by the same supplier over time — `INV01166` has been issued to
// IT02893930921 twice, months apart — so `ambiguous` records that there was more
// than one and the newest was taken, rather than letting the table imply certainty.
function indexWarehouse(rows) {
  const by = new Map();
  for (const r of rows) {
    const key = `${String(r.RECEIPT_NUMBER || "").toUpperCase()}\\u0000${taxKey(r.TAX_ID || r.VAT_NUMBER)}`;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(r);
  }
  const out = new Map();
  for (const [key, list] of by) {
    list.sort((a, b) => Number(b.DOCUMENT_ID) - Number(a.DOCUMENT_ID));
    out.set(key, { ...list[0], ambiguous: list.length > 1 ? list.length : 0 });
  }
  return out;
}

function freshaKey(row) {
  const tax = row.supplier.tax_id;
  return `${String(row.code || "").toUpperCase()}\\u0000${taxKey(`${tax.country || ""}${tax.code || ""}`)}`;
}

function attachWarehouse(rows, index) {
  for (const r of rows) {
    const hit = index.get(freshaKey(r)) || index.get(`${String(r.code || "").toUpperCase()}\\u0000${taxKey(r.supplier.tax_id.code)}`);
    r.fresha = hit
      ? {
          document_id: hit.DOCUMENT_ID ?? null,
          tracker_id: hit.LATEST_TRACKER_ID ?? null,
          sale_id_64: hit.SALE_ID_64 ?? null,
          account_configuration_id: hit.ACCOUNT_CONFIGURATION_ID ?? null,
          upload_status: hit.UPLOAD_STATUS ?? null,
          review_status: hit.REVIEW_STATUS ?? null,
          tracker_updated_at: hit.TRACKER_UPDATED_AT ?? null,
          ambiguous: hit.ambiguous || 0,
        }
      : null;
  }
}

function summarise(entry) {
  const doc = entry?.data?.doc || entry?.data || {};
  const supplier = doc?.supplier || doc?.issuer || {};
  const state = entry?.state || (entry?.draft ? "draft" : null);
  const type = String(doc?.type || entry?.snippet?.type || "").toLowerCase() || null;
  return {
    id: entry?.id ?? null,
    folder: entry?.folder ?? null,
    state,
    status: classify(state),
    invalid: Boolean(entry?.invalid),
    kind: CREDIT_TYPES.includes(type) ? "credit-note" : "invoice",
    type,
    series: doc?.series ?? entry?.snippet?.series ?? null,
    code: doc?.code ?? entry?.snippet?.code ?? null,
    issue_date: doc?.issue_date ?? null,
    created_at: entry?.created_at ?? null,
    updated_at: entry?.updated_at ?? null,
    total: doc?.totals?.payable ?? doc?.totals?.total_with_tax ?? null,
    currency: doc?.currency ?? null,
    supplier: { name: supplier?.name ?? null, tax_id: normaliseTax(supplier?.tax_id) },
    doc_schema: entry?.doc_schema ?? null,
    faults: (entry?.faults || []).map((f) => ({
      provider: f?.provider ?? null,
      code: f?.code ?? null,
      message: f?.message ?? null,
      paths: f?.paths || [],
    })),
    // Filled in from Fresha's own rows when --db is on; null keeps the JSON shape
    // the same whether the warehouse was reachable or not.
    // Filled in once the workspace and Fresha's rows are known; present and null
    // keeps the JSON shape the same either way.
    console_url: null,
    fresha: null,
    links: (entry?.meta || []).filter((m) => m?.link_url).map((m) => ({ src: m?.src ?? null, key: m?.key ?? null, url: m.link_url })),
  };
}

function number(s) {
  return [s.series, s.code].filter(Boolean).join("-") || null;
}

// ---------------------------------------------------------------------------
// Why — the aggregate
// ---------------------------------------------------------------------------

// A provider's message carries the document it is about: an id, a number, a
// timestamp. Grouped verbatim, forty receipts that failed for one reason read as
// forty reasons. So the *key* is blurred — ids and numbers stood down to
// placeholders — while the table and the report still show the message as it came.
function messageShape(message) {
  return String(message || "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\d+/g, "#")
    // A date, a time or a version is several numbers with punctuation between
    // them; left as three placeholders they still differ from run to run.
    .replace(/#(?:[-:./T]#)+/gi, "#")
    .replace(/#/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// One reason per fault, not per document: a receipt rejected for two reasons is
// counted under both, which is why the reason counts can add up past the number of
// documents. `documents` is the honest denominator and is reported beside them.
function aggregate(rows) {
  const reasons = new Map();
  for (const r of rows) {
    const faults = r.faults.length ? r.faults : [{ provider: null, code: null, message: null, none: true }];
    for (const f of faults) {
      const key = f.none ? "none" : `${f.provider || ""}|${f.code || messageShape(f.message)}`;
      if (!reasons.has(key)) {
        reasons.set(key, { provider: f.provider || null, code: f.code || null, none: Boolean(f.none), count: 0, documents: new Set(), messages: new Map(), states: new Map(), kinds: new Map() });
      }
      const g = reasons.get(key);
      g.count++;
      if (r.id) g.documents.add(r.id);
      if (f.message) g.messages.set(f.message, (g.messages.get(f.message) || 0) + 1);
      if (r.state) g.states.set(r.state, (g.states.get(r.state) || 0) + 1);
      g.kinds.set(r.kind, (g.kinds.get(r.kind) || 0) + 1);
    }
  }
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return [...reasons.values()]
    .map((g) => ({
      provider: g.provider,
      code: g.code,
      none: g.none,
      count: g.count,
      documents: g.documents.size,
      message: top(g.messages),
      messages: g.messages.size,
      states: [...g.states.keys()].sort(),
      kinds: [...g.kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`),
    }))
    .sort((a, b) => b.documents - a.documents || b.count - a.count);
}

function reasonLabel(r) {
  if (r.none) return "(no fault recorded)";
  return [r.provider, r.code].filter(Boolean).join(" · ") || "(unnamed fault)";
}

// In the documents table the reason is the whole of that column, so a fault with no
// code falls back to its message — "ticket-it" on its own names the provider and
// says nothing about what went wrong. The aggregate prints the message in a column
// of its own and does not need the fallback.
function rowReason(r) {
  const f = r.faults[0];
  if (!f) return "(no fault recorded)";
  const named = [f.provider, f.code].filter(Boolean).join(" · ");
  if (f.code) return named;
  return f.message ? `${named ? `${named}: ` : ""}${f.message}` : named || "(unnamed fault)";
}

// ---------------------------------------------------------------------------
// Rendering. Cells are built plain and padded on the plain text, then painted —
// padding a string that already changed colour counts the escapes as width and
// misaligns every row under it.
// ---------------------------------------------------------------------------

function clip(s, width) {
  const v = String(s ?? "");
  return v.length <= width ? v : `${v.slice(0, Math.max(1, width - 1))}…`;
}

function table(headers, rows, paints = []) {
  if (!rows.length) return "";
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
  const line = (cells, paintRow) =>
    cells
      .map((cell, i) => {
        const text = String(cell ?? "").padEnd(i === cells.length - 1 ? 0 : widths[i]);
        return paintRow ? paintRow(text, i) : text;
      })
      .join("  ")
      .replace(/\s+$/, "");
  const out = [COLOR ? c.faint(line(headers)) : line(headers)];
  rows.forEach((r, n) => out.push(line(r, paints[n])));
  return out.join("\n");
}

function renderDocuments(rows, limit, withDb) {
  const shown = rows.slice(0, limit);
  const fresha = (r, field) => (r.fresha?.[field] ?? null) === null ? "—" : `${r.fresha[field]}${field === "document_id" && r.fresha.ambiguous ? "?" : ""}`;
  const body = shown.map((r) => [
    MARK[r.status] || MARK.unknown,
    clip(number(r) || "(no number)", 24),
    r.kind === "credit-note" ? "credit note" : "invoice",
    r.state || "no state",
    clip(taxLabel(r.supplier.tax_id) || r.supplier.name || "—", 22),
    (r.created_at || "").slice(0, 10) || "—",
    ...(withDb ? [fresha(r, "document_id"), fresha(r, "tracker_id"), fresha(r, "sale_id_64")] : []),
    r.id || "—",
    clip(rowReason(r), 44),
  ]);
  const entryCol = withDb ? 9 : 6;
  // The cell is padded before it is painted, so wrapping it in a hyperlink here
  // cannot throw the column's width out.
  const paints = shown.map((r) => (text, i) => (i === 0 || i === 3 ? paint(r.status, text) : i === entryCol ? hyperlink(c.faint(text), r.console_url) : text));
  const headers = ["", "NUMBER", "TYPE", "STATE", "SUPPLIER", "CREATED", ...(withDb ? ["DOCUMENT", "TRACKER", "SALE_ID_64"] : []), "SILO ENTRY", "REASON"];
  const head = table(headers, body, paints);
  const more = shown.length < rows.length ? `\n${c.faint(`  ${rows.length - shown.length} more, raise --limit`)}` : "";
  // A trailing "?" is the one thing in the table that is not simply a fact.
  const ambiguous = shown.filter((r) => r.fresha?.ambiguous).length;
  const note = ambiguous ? `\n${c.faint(`  ${ambiguous} document id marked ? — the number has been issued to that supplier before, and the newest row was taken`)}` : "";
  return head + more + note;
}

function renderReasons(reasons, total) {
  const body = reasons.map((r) => [
    String(r.documents),
    total ? `${Math.round((r.documents / total) * 100)}%` : "—",
    clip(reasonLabel(r), 34),
    clip(r.message || "", 60) + (r.messages > 1 ? c.faint(` (+${r.messages - 1} wording${r.messages === 2 ? "" : "s"})`) : ""),
  ]);
  const paints = reasons.map((r) => (text, i) => (i === 2 ? (r.none ? c.warn(text) : c.bad(text)) : i === 1 ? c.faint(text) : text));
  return table(["DOCS", "SHARE", "REASON", "MESSAGE"], body, paints);
}

// ---------------------------------------------------------------------------
// Report files
// ---------------------------------------------------------------------------

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeReport(rows, reasons, meta) {
  const day = new Date().toISOString().slice(0, 10);
  const md = path.resolve(`it-receipt-errors-${day}.md`);
  const csv = path.resolve(`it-receipt-errors-${day}.csv`);

  const lines = [];
  lines.push(`# IT Smart Receipts — errored invoices and credit notes`);
  lines.push("");
  lines.push(`- Workspace: ${meta.workspace}`);
  lines.push(`- Window: ${meta.window}`);
  lines.push(`- Scanned: ${meta.scanned} silo entries, ${meta.considered} of them invoices or credit notes`);
  lines.push(`- In error: ${rows.length}`);
  if (meta.truncated) lines.push(`- **The scan stopped at --scan ${meta.scan}; there may be more.**`);
  lines.push("");
  lines.push(`## Why (${reasons.length} distinct reason${reasons.length === 1 ? "" : "s"})`);
  lines.push("");
  lines.push("| Docs | Share | Reason | Message | Kinds |");
  lines.push("|---|---|---|---|---|");
  for (const r of reasons) {
    const share = rows.length ? `${Math.round((r.documents / rows.length) * 100)}%` : "—";
    lines.push(`| ${r.documents} | ${share} | ${mdCell(reasonLabel(r))} | ${mdCell(r.message || "")}${r.messages > 1 ? ` _(+${r.messages - 1} more wording${r.messages === 2 ? "" : "s"})_` : ""} | ${r.kinds.join(", ")} |`);
  }
  lines.push("");
  lines.push("## Documents");
  lines.push("");
  lines.push("| | Number | Type | State | Supplier | Created | Document | Tracker | sale_id_64 | Silo entry | Reason |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const reason = rowReason(r);
    const entry = r.console_url ? `[${r.id}](${r.console_url})` : r.id || "—";
    const f = (k) => (r.fresha?.[k] ?? null) === null ? "—" : String(r.fresha[k]);
    lines.push(
      `| ${MARK[r.status] || MARK.unknown} | ${mdCell(number(r) || "(no number)")} | ${r.kind === "credit-note" ? "credit note" : "invoice"} | ${r.state || "no state"} | ` +
        `${mdCell(taxLabel(r.supplier.tax_id) || r.supplier.name || "—")} | ${(r.created_at || "").slice(0, 10) || "—"} | ` +
        `${f("document_id")}${r.fresha?.ambiguous ? " ?" : ""} | ${f("tracker_id")} | ${f("sale_id_64")} | ${entry} | ${mdCell(reason)} |`
    );
  }
  lines.push("");
  fs.writeFileSync(md, lines.join("\n"));

  fs.writeFileSync(csv, csvText(rows));
  return { md, csv };
}

// One row per fault, not per document: a receipt rejected for two reasons is two
// rows, so a pivot over the reasons needs no unpacking. A document with no fault at
// all still gets its row, with the three fault columns empty.
function csvText(rows) {
  const head = [
    "number", "kind", "type", "state", "invalid", "supplier_tax_id", "supplier_name", "issue_date", "created_at", "entry_id",
    "document_id", "tracker_id", "sale_id_64", "account_configuration_id", "upload_status", "review_status", "document_ambiguous",
    "console_url", "fault_provider", "fault_code", "fault_message", "link",
  ];
  const body = [head.join(",")];
  for (const r of rows) {
    const faults = r.faults.length ? r.faults : [{ provider: "", code: "", message: "" }];
    const w = r.fresha || {};
    for (const f of faults) {
      body.push(
        [
          number(r) || "", r.kind, r.type || "", r.state || "", r.invalid ? "true" : "false", taxLabel(r.supplier.tax_id) || "", r.supplier.name || "", r.issue_date || "", r.created_at || "", r.id || "",
          w.document_id ?? "", w.tracker_id ?? "", w.sale_id_64 ?? "", w.account_configuration_id ?? "", w.upload_status ?? "", w.review_status ?? "", w.ambiguous ? "true" : "",
          r.console_url || "", f.provider || "", f.code || "", f.message || "", r.links[0]?.url || "",
        ]
          .map(csvCell)
          .join(",")
      );
    }
  }
  return body.join("\n") + "\n";
}

// `--csv` on its own writes to the system temp directory, which is the point: the
// file is wanted for the next command, not for the repository. A path may be given
// instead, and a directory is treated as one — the name is still the script's.
function csvDestination(where) {
  const day = new Date().toISOString().slice(0, 10);
  const name = `it-receipt-errors-${day}.csv`;
  if (!where) return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "it-receipt-errors-")), name);
  const at = path.resolve(where);
  let isDir = false;
  try {
    isDir = fs.statSync(at).isDirectory();
  } catch {
    // It does not exist yet: a trailing separator is the only thing that still
    // says "directory", and anything else is taken as the file to write.
    isDir = /[\\/]$/.test(where);
  }
  if (isDir) fs.mkdirSync(at, { recursive: true });
  else fs.mkdirSync(path.dirname(at), { recursive: true });
  return isDir ? path.join(at, name) : at;
}

function mdCell(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const token = await resolveToken(opts.json);

  const ws = await api(opts.baseUrl, token, "/access/v1/workspace");
  const workspace = ws.data || {};
  const windowLabel = opts.cutoff ? `since ${opts.cutoff.toISOString()} (--since ${opts.since})` : "all time";
  if (!opts.json) {
    process.stderr.write(c.header("Workspace") + `  ${workspace.name || workspace.slug || "(unnamed)"}` + c.faint(`  · ${windowLabel}\n`));
    process.stderr.write(c.faint(`Reading the silo, newest first, a page at a time, to --scan ${opts.scan}…\n`));
  }

  const swept = await sweep(opts.baseUrl, token, { folder: opts.folder, cutoff: opts.cutoff, scan: opts.scan });

  // A receipt and a credit note are both bill/invoice documents; the parties the
  // silo also holds are not what was asked about.
  const docs = swept.list.filter(isReceiptDoc);
  const considered = docs.length;

  // The state is on the listed entry, so the sweep can be narrowed to the failures
  // before anything is fetched a second time. Everything else the table needs —
  // the supplier, the type, the faults — only exists on the fetched entry.
  const failed = docs.filter((e) => opts.states.includes(String(e?.state || "").toLowerCase()));
  if (!opts.json && failed.length) process.stderr.write(c.faint(`Fetching ${failed.length} errored entr${failed.length === 1 ? "y" : "ies"} for their faults…\n`));
  let rows = (await hydrate(opts.baseUrl, token, failed)).map(summarise);

  if (opts.type !== "all") rows = rows.filter((r) => (opts.type === "credit-notes" ? r.kind === "credit-note" : r.kind === "invoice"));
  if (opts.taxId) rows = rows.filter((r) => taxMatches(opts.taxId, r.supplier.tax_id));
  rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  for (const r of rows) r.console_url = consoleUrl(opts.consoleUrl, workspace, r);

  // Fresha's own ids for the same receipts: which accounting document, which
  // tracker, which sale. One query for the whole table, asked only about the ones
  // that failed.
  let dbError = null;
  let withDb = opts.db && rows.length > 0;
  if (withDb) {
    const pairs = rows.map((r) => ({ code: r.code, tax: `${r.supplier.tax_id.country || ""}${r.supplier.tax_id.code || ""}` })).filter((p) => p.code && taxKey(p.tax));
    if (pairs.length > MB_MAX_CLAUSES) {
      dbError = `${pairs.length} receipts is past the ${MB_MAX_CLAUSES} this asks for in one query — narrow --since, or pass --no-db`;
      withDb = false;
    } else if (!pairs.length) {
      dbError = "none of the errored documents names both a number and a supplier tax ID";
      withDb = false;
    } else {
      if (!opts.json) process.stderr.write(c.faint(`Looking ${pairs.length} up in Snowflake Postgres, through the Metabase CLI…\n`));
      const got = warehouseLookup(pairs, opts.mbDatabase);
      if (got.error) {
        dbError = got.error;
        withDb = false;
      } else {
        attachWarehouse(rows, indexWarehouse(got.rows));
      }
    }
    if (dbError && !opts.json) ui_warn(`Fresha's own ids were skipped — ${dbError}`);
  }

  const reasons = aggregate(rows);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          workspace: { name: workspace.name ?? null, slug: workspace.slug ?? null, country: workspace.country ?? null },
          window: { since: opts.since, cutoff: opts.cutoff ? opts.cutoff.toISOString() : null },
          scanned: swept.scanned,
          considered,
          truncated: swept.truncated,
          fresha_error: dbError,
          count: rows.length,
          reasons,
          entries: rows,
        },
        null,
        2
      ) + "\n"
    );
    process.exit(rows.length ? 1 : 0);
  }

  // --csv is an export, not a view: the file (or stdout) is the whole of the
  // answer, and the counts that would frame it go to stderr where a pipe cannot
  // pick them up.
  if (opts.csv !== null) {
    const text = csvText(rows);
    if (opts.csv === "-") {
      process.stdout.write(text);
    } else {
      const at = csvDestination(opts.csv);
      fs.writeFileSync(at, text);
      process.stdout.write(`${at}\n`);
    }
    process.stderr.write(
      c.faint(`${rows.length} errored of ${considered} invoices and credit notes, from ${swept.scanned} silo entries read\n`)
    );
    if (swept.truncated) ui_warn(`the scan stopped at --scan ${opts.scan} — there may be more; raise it or narrow --since`);
    process.exit(rows.length ? 1 : 0);
  }

  const scope = [opts.type !== "all" && opts.type, opts.taxId && `tax ID ${opts.taxId}`, opts.folder ? `folder ${opts.folder}` : "every folder"].filter(Boolean).join(" · ");
  process.stdout.write(
    `\n${c.header("Errored")}  ${rows.length}` +
      c.faint(` of ${considered} invoice${considered === 1 ? "" : "s"} and credit note${considered === 1 ? "" : "s"}, from ${swept.scanned} silo entries read${scope ? ` · ${scope}` : ""}\n`)
  );
  if (swept.truncated) ui_warn(`the scan stopped at --scan ${opts.scan} — there may be more; raise it or narrow --since`);
  if (!considered) {
    process.stdout.write(
      c.faint(
        `    Nothing in the window is a bill/invoice document. The token decides the workspace —\n` +
          `    an IT receipt is not in the ES VeriFactu one — and --since ${opts.since} may simply be too short.\n`
      )
    );
  }

  if (rows.length) {
    process.stdout.write(`\n${renderDocuments(rows, opts.limit, withDb)}\n`);
    process.stdout.write(`\n${c.header("Why")}  ${c.faint(`${reasons.length} distinct reason${reasons.length === 1 ? "" : "s"} across ${rows.length} document${rows.length === 1 ? "" : "s"}`)}\n`);
    process.stdout.write(`${renderReasons(reasons, rows.length)}\n`);
  } else if (considered) {
    process.stdout.write(`${c.ok("✓")} nothing in the window is in an error state\n`);
  }

  if (opts.report) {
    const written = writeReport(rows, reasons, {
      workspace: workspace.name || workspace.slug || "(unnamed)",
      window: windowLabel,
      scanned: swept.scanned,
      considered,
      truncated: swept.truncated,
      scan: opts.scan,
    });
    process.stderr.write(c.faint(`\nwrote ${written.md}\nwrote ${written.csv}\n`));
  }

  // 1 means the data is wrong: something in the window did not land.
  process.exit(rows.length ? 1 : 0);
}

main().catch((err) => fail(err.stack || err.message, 2));
