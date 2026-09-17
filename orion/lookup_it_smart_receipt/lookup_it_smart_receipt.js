#!/usr/bin/env node
"use strict";

// lookup_it_smart_receipt — find one IT Smart Receipt in Invopop and say what state it is in.
//
// Self-contained on purpose: one directory, one entrypoint, no shared library.
// Copy helpers from a sibling script rather than importing them.
//
// Transport: Invopop REST API (https://api.invopop.com), global fetch. No houston.
// Auth: Bearer token from SMART_RECEIPTS_READ_ONLY_API_TOKEN, else a paste prompt with
//       the echo off.
//       The token decides the workspace, and therefore the country and integration —
//       the workspace is printed first so you can see you asked the right one.
//
// Read-only: two GETs, no writes anywhere, nothing to dry-run.
//   1. GET /access/v1/workspace          — whose workspace this token opens
//   2. GET /silo/v1/entries/{id}         — when the argument is a UUID
//      GET /silo/v1/search?q=…           — otherwise, a free-text search
//
// The receipt number is whatever is printed on the receipt: the search is
// free-text over the workspace's documents, so a series+code, a code on its own
// or an Invopop entry UUID all find it.

const fs = require("fs");
const { spawnSync } = require("child_process");
const os = require("os");
const path = require("path");
const readline = require("readline");
const readlinePromises = require("readline/promises");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { header: sgr("1;37"), cmd: sgr("33"), sql: sgr("36"), faint: sgr("2"), ok: sgr("32"), bad: sgr("31"), warn: sgr("1;33") };

const DEFAULT_BASE_URL = "https://api.invopop.com";
const TOKEN_ENV = "SMART_RECEIPTS_READ_ONLY_API_TOKEN";
const TIMEOUT_MS = 20000;
// Fresha's own side of the story, read through the Metabase CLI. Invopop only
// knows what reached it; when a receipt never did, the warehouse is the only place
// that says so — and it is also the only place that knows which tax ID the
// receipt's account configuration actually carries.
const MB_DATABASE = 87; // "Snowflake Postgres" in metabase.data-eng.fresha.io
const DOC_TABLE = "ACCOUNTING_DOCUMENTS.PUBLIC_ACCOUNTING_DOCUMENTS";
const TRACKER_TABLE = "ACCOUNTING_DOCUMENTS.PUBLIC_E_INVOICE_TRACKERS";
const CONFIG_TABLE = "ACCOUNTING_DOCUMENTS.PUBLIC_ACCOUNT_CONFIGURATIONS";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A tax ID is typed a dozen ways — "IT 1234567890 1", "it-12345678901", with or
// without the country in front — and they all mean the same registration. Compare
// on the digits and letters alone, and let a code match whether or not the country
// is on it, since the receipt prints it both ways.
function taxKey(v) {
  return String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Exact, not a suffix: "2660921" is not a shorter way of writing "04042660921",
// it is a different number, and matching it would quietly answer about the wrong
// supplier. Only the same registration written differently counts — with or
// without its country in front, and however it is spaced or punctuated.
function taxMatches(want, tax) {
  const w = taxKey(want);
  if (!w) return true;
  const full = taxKey(`${tax?.country || ""}${tax?.code || ""}`);
  const bare = taxKey(tax?.code);
  return w === full || w === bare;
}

// GOBL keeps the country in its own field, but it is routinely typed into the code
// as well — "IT04042660921" alongside country "IT". Left alone that prints as
// "IT IT04042660921" and, worse, splits one supplier into two sections depending
// on which way each document happened to be filed. So the country is kept once:
// the prefix is dropped when it repeats the country field, and adopted as the
// country when there is no country field to repeat.
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

// Invopop silo states: draft, processing, registered, completed, sent, received,
// paid, error, rejected, void, invalid. Same buckets check_invopop_suppliers uses,
// so a state means the same thing whichever script shows it to you.
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

// The search index is eventually consistent, and "eventually" has been observed at
// twenty-five minutes: a document sent at 13:31 was still absent from a search at
// 13:54 while the console showed it sent. Entries fetched by id are current; these
// are not. Saying so is the difference between a stale answer and a wrong one.
const STALE_WINDOW_MS = 2 * 60 * 60 * 1000;

function staleNote(entries, warehouseRows) {
  const newestSend = (warehouseRows || [])
    .map((r) => Date.parse(r.TRACKER_UPDATED_AT || ""))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => b - a)[0];
  const newestEntry = entries
    .map((e) => Date.parse(e.created_at || ""))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => b - a)[0];
  if (!entries.length) return "nothing here yet does not mean nothing was sent — the search index lags, sometimes by half an hour";
  if (newestSend && Date.now() - newestSend < STALE_WINDOW_MS && (!newestEntry || newestEntry < newestSend)) {
    return "Fresha sent this more recently than anything shown here — the search index lags, so this may be the previous attempt";
  }
  return null;
}

function ui_warn(message) {
  process.stderr.write(`${c.warn("warning:")} ${message}\n`);
}

function usage() {
  return `lookup_it_smart_receipt — find an IT Smart Receipt in Invopop and report its status

Usage:
  lookup_it_smart_receipt [flags] <RECEIPT>

Arguments:
  RECEIPT                the receipt number as printed on it, or an Invopop entry UUID.
                         Asked for on a terminal when left out.

Flags:
  -f, --folder NAME      only search this silo folder (default: every folder)
  -t, --tax-id CODE      only the supplier with this tax ID, with or without the
                         country in front. Asked for on a terminal when left out;
                         answer nothing and matches from more than one supplier
                         are shown in a section each.
  -l, --limit N          how many matches to report (default 20). It caps what is
                         shown, never what is searched — the count above the report
                         is always the true number found
      --scan N           how many search candidates to read before judging them.
                         The search answers 100 at a time and there are often more;
                         every page is read up to this many (default 500)
      --base-url URL     Invopop API base URL (default ${DEFAULT_BASE_URL})
      --loose            keep every search hit, not only the documents whose
                         number is exactly the one asked for
      --db, --no-db      also look the receipt up in Snowflake Postgres through
                         the Metabase CLI, which knows whether it was ever sent
                         and which tax ID its account configuration carries.
                         Asked for on a terminal when neither is given.
  -c, --config N         narrow the Fresha side to one account configuration —
                         its id or its plugin id, whichever your sheet carries
      --mb-database N    Metabase database id to query (default ${MB_DATABASE})
      --json             emit JSON instead of a report; never prompts
  -h, --help             show this help

The token comes from $${TOKEN_ENV}, and is asked for with the echo
off when that is unset. \`ops secrets set ${TOKEN_ENV}\` saves it
so the question is asked once.

Exit codes: 0 the receipt was found and is not in an error state, 1 it was not found
or it is in one, 2 the call was wrong or the token was refused.
`;
}

function parseArgs(argv) {
  const o = { folder: null, taxId: null, loose: false, db: null, config: null, mbDatabase: MB_DATABASE, limit: 20, scan: 500, baseUrl: process.env.INVOPOP_API_BASE_URL || DEFAULT_BASE_URL, json: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { process.stdout.write(usage()); process.exit(0); }
    else if (a === "-f" || a === "--folder") o.folder = argv[++i];
    else if (a === "-t" || a === "--tax-id") o.taxId = argv[++i];
    else if (a === "-l" || a === "--limit") o.limit = Number(argv[++i]);
    else if (a === "--scan") o.scan = Number(argv[++i]);
    else if (a === "--base-url") o.baseUrl = argv[++i];
    else if (a === "--loose") o.loose = true;
    else if (a === "--db") o.db = true;
    else if (a === "--no-db") o.db = false;
    else if (a === "--mb-database") o.mbDatabase = Number(argv[++i]);
    else if (a === "-c" || a === "--config") o.config = Number(argv[++i]);
    else if (a === "--json") o.json = true;
    else if (a.startsWith("-")) fail(`unknown flag: ${a}`, 2);
    else o.positional.push(a);
  }
  if (o.positional.length > 1) fail(`expected one receipt, got ${o.positional.length}: ${o.positional.join(" ")}`, 2);
  if (!Number.isInteger(o.limit) || o.limit < 1) fail("--limit must be a whole number, 1 or more", 2);
  if (!Number.isInteger(o.scan) || o.scan < 1) fail("--scan must be a whole number, 1 or more", 2);
  return o;
}

function fail(message, code) {
  process.stderr.write(`${c.bad("error:")} ${message}\n`);
  process.exit(code);
}

// One readline interface for the whole process, per the house rule: opening and
// closing one per question loses the queued answers on a piped stdin. It is closed
// before the token prompt, which needs the terminal raw and unbuffered.
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
  try {
    if (!opts.positional.length) {
      const typed = (await lines().question("Receipt number (as printed on it), or an entry UUID: ")).trim();
      if (typed) opts.positional.push(typed);
    }
    if (opts.taxId === null) {
      const typed = (await lines().question("Supplier tax ID (Enter to see every supplier that matches): ")).trim();
      if (typed) opts.taxId = typed;
    }
    if (opts.db === null) {
      const typed = (await lines().question("Also look it up in Snowflake Postgres, through the Metabase CLI? [Y/n] ")).trim().toLowerCase();
      opts.db = typed === "" || typed === "y" || typed === "yes";
    }
  } finally {
    closeLines();
  }
}

// One prompt, echo off, straight from the tty. Never on a piped stdin: a token
// read from a pipe would be a token in a file somewhere.
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

async function api(baseUrl, token, path, params) {
  const url = new URL(path, baseUrl);
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

// The search answers 100 at a time and there is usually more than that: asking for
// INV01163 returns 117. Reading one page and filtering it looks like an answer and
// is not one — the exact match may sit on page two. So every page is read before
// anything is judged, up to --scan.
const PAGE = 100;

async function searchAll(baseUrl, token, receipt, folder, scan) {
  const list = [];
  const seen = new Set();
  for (let offset = 0; list.length < scan; offset += PAGE) {
    const got = await api(baseUrl, token, "/silo/v1/search", { q: receipt, folder, limit: PAGE, offset });
    const page = got.missing ? [] : got.data?.list || [];
    for (const e of page) {
      if (e?.id && !seen.has(e.id)) {
        seen.add(e.id);
        list.push(e);
      }
    }
    if (page.length < PAGE) return { list, truncated: false };
  }
  return { list, truncated: true };
}

// Every candidate has to be fetched to learn its number, which is a GET each. The
// snippet is a partial copy of the document and carries the code often enough to
// be worth consulting: when it has one and it is not the number asked for, that
// candidate is dropped unread. When it has none, the fetch happens — a snippet's
// silence is not evidence.
function snippetRulesOut(entry, receipt) {
  const code = entry?.snippet?.code;
  if (!code) return false;
  const want = String(receipt).trim().toUpperCase().replace(/\s+/g, "");
  const series = entry?.snippet?.series;
  const forms = [code, series && `${series}-${code}`, series && `${series}${code}`]
    .filter(Boolean)
    .map((v) => String(v).toUpperCase().replace(/\s+/g, ""));
  return !forms.includes(want);
}

// A search result carries the entry but not always the envelope: the API includes
// `data` "when fetching … and in entry lists", and a search is neither. Without it
// there is no supplier and no tax ID, so anything the search returned thin is
// fetched again by id, where the document is always included — at most one GET per
// candidate the snippet could not rule out, run a few at a time.
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

// Invopop's search is free text, so asking for INV01118 also answers with
// INV011180 and with anything that merely mentions it. A receipt number names one
// receipt, so the search is treated as a way of finding candidates and the answer
// is the ones whose number really is the one asked for. --loose keeps the rest.
function receiptForms(s) {
  const forms = new Set();
  const add = (v) => {
    const k = String(v || "").trim().toUpperCase().replace(/\s+/g, "");
    if (k) forms.add(k);
  };
  add(s.code);
  add(s.id);
  if (s.series) {
    add(`${s.series}-${s.code}`);
    add(`${s.series}${s.code}`);
    add(`${s.series}/${s.code}`);
  }
  return forms;
}

function isExact(s, receipt) {
  return receiptForms(s).has(String(receipt).trim().toUpperCase().replace(/\s+/g, ""));
}

function sqlQuote(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

// The same tolerance the Invopop side uses, expressed in SQL: compare on letters
// and digits alone, and treat a code with its country in front as the same
// registration as one without. The row's own COUNTRY_CODE supplies the prefix, so
// no backreference is needed and the comparison stays exact — a suffix match would
// answer about the wrong supplier here as surely as it would there.
function taxPredicate(taxId) {
  const k = taxKey(taxId);
  const bare = k.replace(/^[A-Z]{2}(?=\d)/, "");
  const norm = (col) => `REGEXP_REPLACE(UPPER(COALESCE(${col}, '')), '[^A-Z0-9]', '')`;
  const country = "UPPER(COALESCE(c.COUNTRY_CODE, ''))";
  const one = (col) =>
    `(${norm(col)} IN (${sqlQuote(k)}, ${sqlQuote(bare)}) OR ${norm(col)} = ${country} || ${sqlQuote(bare)})`;
  return `  AND (${one("c.TAX_ID")} OR ${one("c.VAT_NUMBER")})`;
}

// One query: the document, the tracker that last tried to send it, and the tax
// identity of its account configuration.
function warehouseSql(receipt, config, taxId) {
  // The sheets people work from carry either id, and they are one apart in a way
  // that invites the wrong one, so both are accepted and either may match.
  const narrow = config ? `  AND (d.ACCOUNT_CONFIGURATION_ID = ${Number(config)} OR d.ACCOUNT_CONFIGURATION_PLUGIN_ID = ${Number(config)})` : "";
  return [
    "SELECT d.ID AS DOCUMENT_ID, d.RECEIPT_NUMBER, d.DOCUMENT_TYPE, d.PROVIDER_ID,",
    "       d.ACCOUNT_CONFIGURATION_ID, d.ACCOUNT_CONFIGURATION_PLUGIN_ID, d.CREATED_AT,",
    "       c.COUNTRY_CODE, c.TAX_ID, c.VAT_NUMBER,",
    "       t.ID AS TRACKER_ID, t.UPLOAD_STATUS, t.REVIEW_STATUS, t.UPDATED_AT AS TRACKER_UPDATED_AT",
    `FROM ${DOC_TABLE} d`,
    `LEFT JOIN ${CONFIG_TABLE} c ON c.ID = d.ACCOUNT_CONFIGURATION_ID`,
    `LEFT JOIN ${TRACKER_TABLE} t ON t.ID = d.LATEST_TRACKER_ID`,
    `WHERE d.RECEIPT_NUMBER = ${sqlQuote(receipt)}`,
    taxId ? taxPredicate(taxId) : "",
    narrow,
    "ORDER BY d.ID",
  ]
    .filter(Boolean)
    .join("\n");
}

// `mb` is the Metabase CLI (`mb auth login` once). A missing or unauthenticated
// CLI is reported and stepped over: the Invopop half of the answer still stands.
function warehouseLookup(receipt, database, config, taxId) {
  const body = JSON.stringify({ database, type: "native", native: { query: warehouseSql(receipt, config, taxId) } });
  const file = path.join(os.tmpdir(), `lookup-receipt-${process.pid}.json`);
  fs.writeFileSync(file, body);
  try {
    const r = spawnSync("mb", ["query", "--file", file, "--json", "--max-bytes", "0"], { encoding: "utf8", timeout: 60000 });
    if (r.error) return { error: r.error.code === "ENOENT" ? "the Metabase CLI (mb) is not on PATH" : r.error.message };
    let out = null;
    try {
      out = JSON.parse(r.stdout || "{}");
    } catch {
      return { error: `mb returned something that is not JSON: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}` };
    }
    if (out?.ok === false || out?.error) return { error: out?.error?.message || "mb reported an error" };
    if (!out?.data?.cols) return { error: "mb returned no result set — is the profile logged in? (mb auth status)" };
    const cols = out.data.cols.map((c) => c.name);
    return { rows: (out.data.rows || []).map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]]))) };
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      /* it was a temp file either way */
    }
  }
}

function reportWarehouse(rows, scope) {
  const out = [c.header("In Fresha") + c.faint("  · Snowflake Postgres, via the Metabase CLI")];
  if (!rows.length) {
    return out.concat(`  ${c.warn("?")} no accounting document matches${scope ? ` ${scope}` : " this receipt number"}`).join("\n");
  }
  for (const r of rows) {
    const sent = String(r.UPLOAD_STATUS || "").toLowerCase();
    const mark = sent === "sent" || sent === "completed" ? c.ok("✓") : sent === "not_started" ? c.warn("…") : c.bad("✗");
    out.push(`  ${mark} document ${c.header(String(r.DOCUMENT_ID))}  ${r.DOCUMENT_TYPE || ""}  ${c.faint(`issued ${String(r.CREATED_AT || "").slice(0, 10)}`)}`);
    const row = (k, v) => out.push(`      ${c.faint(k.padEnd(13))} ${v}`);
    row("Config", `${r.ACCOUNT_CONFIGURATION_ID}${r.ACCOUNT_CONFIGURATION_PLUGIN_ID ? c.faint(`  · plugin ${r.ACCOUNT_CONFIGURATION_PLUGIN_ID}`) : ""}`);
    if (r.TAX_ID || r.COUNTRY_CODE) row("Tax ID", `${c.header(String(r.TAX_ID || r.VAT_NUMBER || "—"))}${r.COUNTRY_CODE ? c.faint(`  · ${r.COUNTRY_CODE}`) : ""}`);
    if (r.PROVIDER_ID) row("Provider", String(r.PROVIDER_ID));
    if (r.TRACKER_ID) {
      row("Tracker", `${r.TRACKER_ID}  upload ${c.header(String(r.UPLOAD_STATUS))}  ·  review ${String(r.REVIEW_STATUS)}`);
      if (sent === "not_started") row("", c.warn("never uploaded — nothing about it will exist in Invopop"));
    }
  }
  return out.join("\n");
}

// The bits of an entry worth reading, dug out defensively: this is one shape of
// many and a missing field is not an error.
function summarise(entry) {
  const doc = entry?.data?.doc || entry?.data || {};
  const state = entry?.state || (entry?.draft ? "draft" : null);
  const supplier = doc?.supplier || doc?.issuer || {};
  return {
    supplier: { name: supplier?.name ?? null, tax_id: normaliseTax(supplier?.tax_id) },
    id: entry?.id ?? null,
    folder: entry?.folder ?? null,
    state,
    status: classify(state),
    invalid: Boolean(entry?.invalid),
    created_at: entry?.created_at ?? null,
    series: doc?.series ?? null,
    code: doc?.code ?? null,
    issue_date: doc?.issue_date ?? null,
    doc_schema: entry?.doc_schema ?? null,
    faults: (entry?.faults || []).map((f) => ({ provider: f?.provider ?? null, code: f?.code ?? null, message: f?.message ?? null })),
    links: (entry?.meta || []).filter((m) => m?.link_url).map((m) => ({ src: m?.src ?? null, key: m?.key ?? null, url: m.link_url })),
  };
}

function report(s, pad = "", withSupplier = true) {
  const mark = paint(s.status, MARK[s.status]);
  const number = [s.series, s.code].filter(Boolean).join("-") || c.faint("(no code on the document)");
  const out = [];
  out.push(`${pad}${mark} ${c.header(number)}  ${paint(s.status, s.state || "no state")}`);
  const row = (k, v) => out.push(`${pad}    ${c.faint(k.padEnd(11))} ${v}`);
  if (s.folder) row("Folder", s.folder);
  // Under a section heading the supplier is already named above every entry.
  const tax = taxLabel(s.supplier.tax_id);
  if (withSupplier && (tax || s.supplier.name)) row("Supplier", [tax && c.header(tax), s.supplier.name].filter(Boolean).join("  ·  "));
  if (s.issue_date) row("Issued", s.issue_date);
  if (s.created_at) row("In Invopop", s.created_at);
  if (s.id) row("Entry", s.id);
  if (s.invalid) row("Invalid", c.bad("the envelope's contents need review"));
  for (const f of s.faults) {
    row("Fault", `${c.bad(f.code || "fault")}${f.provider ? c.faint(` (${f.provider})`) : ""}${f.message ? ` — ${f.message}` : ""}`);
  }
  for (const l of s.links) row("Link", `${c.cmd(l.url)}${l.src ? c.faint(` (${l.src})`) : ""}`);
  return out.join("\n");
}

// One flat list when there is nothing to separate — a single supplier, or one the
// caller already named — and a section per supplier when the same number came back
// for more than one of them.
function render(found, taxId, limit = Infinity) {
  const shown = found.slice(0, limit);
  const groups = new Map();
  for (const s of found) {
    const key = taxKey(`${s.supplier.tax_id.country || ""}${s.supplier.tax_id.code || ""}`) || "\u0000unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  if (taxId || groups.size <= 1) {
    const head = found.length > 1 ? c.faint(`${found.length} documents match${shown.length < found.length ? `, showing ${shown.length}` : ""}:\n\n`) : "";
    return head + shown.map((s) => report(s)).join("\n\n");
  }

  let budget = limit;
  const sections = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, list]) => {
      const { name, tax_id } = list[0].supplier;
      const label = taxLabel(tax_id) || "no tax ID on the document";
      const count = `${list.length} document${list.length === 1 ? "" : "s"}`;
      // The cap spans the whole report, so a long first section cannot crowd the
      // later suppliers off the page entirely — each section says what it holds.
      const take = list.slice(0, Math.max(0, budget));
      budget -= take.length;
      const more = take.length < list.length ? c.faint(`  (${list.length - take.length} more, raise --limit)`) : "";
      return `${c.header(label)}${name ? `  ·  ${name}` : ""}  ${c.faint(count)}${more}${take.length ? `\n\n${take.map((s) => report(s, "  ", false)).join("\n\n")}` : ""}`;
    });
  return c.faint(`${found.length} documents match, from ${groups.size} suppliers:\n\n`) + sections.join("\n\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await askMissing(opts);
  if (!opts.positional.length) fail("no receipt given — pass the number printed on the receipt, or an entry UUID", 2);
  const receipt = opts.positional[0];
  const token = await resolveToken(opts.json);

  // Fresha first when asked for: it knows whether the receipt was ever sent, and
  // its account configuration carries the tax ID that tells the suppliers apart.
  let warehouse = null;
  if (opts.db) {
    warehouse = warehouseLookup(receipt, opts.mbDatabase, opts.config, opts.taxId);
    if (!opts.json && warehouse.error) ui_warn(`Snowflake lookup skipped — ${warehouse.error}`);
    // A receipt number repeats across configurations — Fresha's own rows prove it,
    // several countries deep — so its tax ID is only borrowed when every row
    // agrees on one. Picking the first would answer confidently about a supplier
    // nobody asked after.
    const taxes = [...new Set((warehouse.rows || []).map((r) => r.TAX_ID || r.VAT_NUMBER).filter(Boolean))];
    if (!opts.taxId && taxes.length === 1) {
      opts.taxId = taxes[0];
      if (!opts.json) process.stderr.write(c.faint(`Using the account configuration's tax ID: ${taxes[0]}\n`));
    } else if (!opts.taxId && taxes.length > 1 && !opts.json) {
      process.stderr.write(c.faint(`${taxes.length} configurations issue this number — pass --tax-id or --config to pick one.\n`));
    }
  }

  const ws = await api(opts.baseUrl, token, "/access/v1/workspace");
  const workspace = ws.data || {};


  let entries = [];
  let scanned = 0;
  let truncated = false;
  let skipped = 0;
  if (UUID_RE.test(receipt)) {
    const got = await api(opts.baseUrl, token, `/silo/v1/entries/${receipt}`);
    if (!got.missing && got.data) entries = [got.data];
  } else {
    const found = await searchAll(opts.baseUrl, token, receipt, opts.folder, opts.scan);
    scanned = found.list.length;
    truncated = found.truncated;
    entries = opts.loose ? found.list : found.list.filter((e) => !snippetRulesOut(e, receipt));
    skipped = found.list.length - entries.length;
  }

  const hits = (await hydrate(opts.baseUrl, token, entries)).map(summarise);
  // Exact first: the search found candidates, these are the ones that are actually
  // the receipt asked for.
  const all = opts.loose ? hits : hits.filter((s) => isExact(s, receipt));
  // A receipt number is only unique within a supplier, so the same number can come
  // back for several. --tax-id picks one; without it they are shown apart.
  const found = opts.taxId ? all.filter((s) => taxMatches(opts.taxId, s.supplier.tax_id)) : all;

  if (!opts.json && warehouse && !warehouse.error) {
    const scope = [`receipt ${receipt}`, opts.taxId && `tax ID ${opts.taxId}`, opts.config && `configuration ${opts.config}`].filter(Boolean).join(" · ");
    process.stdout.write(reportWarehouse(warehouse.rows, scope) + "\n\n");
  }
  if (!opts.json) {
    const net = scanned
      ? c.faint(`  · ${scanned} candidate${scanned === 1 ? "" : "s"} read${skipped ? `, ${skipped} ruled out by snippet` : ""}`)
      : "";
    process.stdout.write(c.header("In Invopop") + c.faint(`  · ${workspace.name || workspace.slug || "workspace"}`) + net + "\n");
    if (truncated) process.stdout.write(c.warn(`  the search was cut off at --scan ${opts.scan}; there may be more\n`));
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          receipt,
          tax_id: opts.taxId,
          fresha: warehouse && !warehouse.error ? warehouse.rows : null,
          fresha_error: warehouse?.error ?? null,
          scanned,
          truncated,
          workspace: { name: workspace.name ?? null, slug: workspace.slug ?? null, country: workspace.country ?? null },
          count: found.length,
          entries: found,
        },
        null,
        2
      ) + "\n"
    );
  } else if (!found.length) {
    process.stdout.write(`${c.warn("?")} no document in this workspace matches ${c.header(receipt)}${opts.taxId ? ` for tax ID ${c.header(opts.taxId)}` : ""}\n`);
    // Being told the number exists, just not for that supplier, is the answer
    // nine times out of ten when a tax ID was given.
    if (!all.length && hits.length) {
      const near = [...new Set(hits.map((s) => [s.series, s.code].filter(Boolean).join("-")).filter(Boolean))];
      process.stdout.write(c.faint(`    ${hits.length} document(s) mention it, none numbered exactly ${receipt}${near.length ? `: ${near.slice(0, 8).join(", ")}` : ""}.\n    --loose shows them.\n`));
    } else if (opts.taxId && all.length) {
      const others = [...new Set(all.map((s) => taxLabel(s.supplier.tax_id)).filter(Boolean))];
      if (others.length) {
        process.stdout.write(c.faint(`    ${all.length} document(s) do match ${receipt}, for ${others.join(", ")}.\n`));
      } else {
        // Filtering everything out because the field is missing is not the same
        // as filtering everything out because it did not match, and saying so is
        // the difference between a wrong answer and a useful one.
        process.stdout.write(c.faint(`    ${all.length} document(s) match ${receipt}, but none of them names a supplier tax ID,\n    so the --tax-id filter could not keep any. Run it again without --tax-id to see them.\n`));
      }
    } else {
      process.stdout.write(c.faint(`    The token decides the workspace — an IT receipt will not be found with an ES token.\n    A number printed on the receipt is searched as free text; try the code on its own.\n`));
    }
  } else {
    process.stdout.write(render(found, opts.taxId, opts.limit) + "\n");
  }
  if (!opts.json) {
    const note = staleNote(found, warehouse?.rows);
    if (note) process.stdout.write(c.faint(`    ${note}.\n`));
  }

  // 1 means the data is wrong: nothing found, or what was found is in an error
  // state. A receipt still processing is not a problem, so it stays 0.
  const neverSent = (warehouse?.rows || []).some((r) => String(r.UPLOAD_STATUS || "").toLowerCase() === "not_started");
  if (!opts.json && !found.length && neverSent) {
    process.stdout.write(c.faint("    Fresha says it was never uploaded, so its absence here is expected, not a gap.\n"));
  }
  const bad = !found.length || found.some((f) => f.status === "error" || f.invalid);
  process.exit(bad ? 1 : 0);
}

main().catch((err) => fail(err.stack || err.message, 2));
