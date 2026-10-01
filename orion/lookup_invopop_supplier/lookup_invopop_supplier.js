#!/usr/bin/env node
"use strict";

// lookup_invopop_supplier — find one supplier in an Invopop workspace by its tax ID
// and say whether it is registered: ES Verifactu or IT Smart Receipts.
//
// Self-contained on purpose: one directory, one entrypoint, no shared library.
// Copy helpers from a sibling script rather than importing them.
//
// The regime is the first thing it asks (or --regime): it picks the token, and the
// token picks the workspace. The workspace is printed first and a mismatch warned
// about, so a wrong token is obvious rather than looking like a missing supplier.
//
// Transport: Invopop REST API (https://api.invopop.com), global fetch. No houston.
// Auth: Bearer token from the regime's variable, else a paste prompt, echo off.
//
// Read-only: GETs only, no writes anywhere, nothing to dry-run.
//   1. GET /access/v1/workspace             — whose workspace this token opens
//   2. GET /silo/v1/search?q=…&folder=…     — the supplier's entries, by tax ID
//   3. GET /silo/v1/entries/{id}            — any hit the search returned thin
//   4. GET /silo/v1/entries?folder=…        — the whole folder, when the search
//                                             found nothing (the index lags)
//
// A supplier is a silo entry in the "suppliers" folder, one per registration
// attempt, so the same tax ID usually has several. The newest one is the answer;
// the older ones are the history that explains it.

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
// Everything that differs between the regimes, in one place. `integration` is the
// value Fresha's plugin rows carry, so it doubles as the warehouse filter. Adding a
// regime is a row here and a line in the AGENTS.md table, nothing else.
const REGIMES = {
  verifactu: { country: "ES", label: "ES Verifactu", token: "INVOPOP_ES_VERIFACTU_API_TOKEN_RO", integration: "verifactu", taxName: "NIF", other: "IT" },
  smart_receipts: { country: "IT", label: "IT Smart Receipts", token: "SMART_RECEIPTS_READ_ONLY_API_TOKEN", integration: "smart_receipts", taxName: "partita IVA", other: "ES" },
};
// Set once the regime is known; everything after the questions reads it.
let REGIME = null;
const TIMEOUT_MS = 20000;
const SUPPLIERS_FOLDER = "suppliers";
// Fresha's own side, read through the Metabase CLI: the account configuration
// plugin that registered this supplier, and whether Fresha thinks it worked.
const MB_DATABASE = 87; // "Snowflake Postgres" in metabase.data-eng.fresha.io
const CONFIG_TABLE = "ACCOUNTING_DOCUMENTS.PUBLIC_ACCOUNT_CONFIGURATIONS";
const PLUGIN_TABLE = "ACCOUNTING_DOCUMENTS.PUBLIC_ACCOUNT_CONFIGURATION_PLUGINS";

// A tax ID is typed a dozen ways — "B-8590549 5", "esb85905495", "IT 0404266092 0",
// with or without the country in front — and they all mean one registration.
// Compare on letters and digits alone, and drop the regime's country only when what
// follows is still a tax ID: a Spanish NIF often starts with a letter of its own
// (B85905495, Y5581133J), so the country is recognised by a digit within two
// characters of it, not one. Exact, never a
// suffix: a shorter number is a different supplier.
function taxKey(v) {
  return String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function bareNif(v) {
  return taxKey(v).replace(new RegExp(`^${REGIME.country}(?=[A-Z]?\\d)`), "");
}

// GOBL keeps the country in its own field, but it is routinely typed into the code
// as well — "ESB85905495" alongside country "ES". The country is kept once.
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

// Same buckets check_invopop_suppliers uses, so a state means the same thing
// whichever script shows it to you — including that faults make an entry an error
// whatever its state says.
const OK_STATES = ["registered", "completed", "sent", "received", "paid", "accepted", "done"];
const PENDING_STATES = ["draft", "processing", "pending", "queued", "waiting"];
const ERROR_STATES = ["error", "rejected", "invalid"];
const VOIDED_STATES = ["void", "voided", "cancelled", "canceled"];

const MARK = { ok: "✓", pending: "…", error: "✗", voided: "⊘", unknown: "?" };

function classify(entry) {
  const s = String(entry?.state || "").toLowerCase();
  if (VOIDED_STATES.includes(s)) return "voided";
  if (ERROR_STATES.includes(s)) return "error";
  if ((entry?.faults || []).length || entry?.invalid) return "error";
  if (OK_STATES.includes(s)) return "ok";
  if (PENDING_STATES.includes(s) || entry?.draft || s === "") return "pending";
  return "unknown";
}

function paint(kind, text) {
  if (kind === "ok") return c.ok(text);
  if (kind === "error") return c.bad(text);
  if (kind === "pending") return c.sql(text);
  if (kind === "voided") return c.faint(text);
  return c.warn(text);
}

function ui_warn(message) {
  process.stderr.write(`${c.warn("warning:")} ${message}\n`);
}

function usage() {
  return `lookup_invopop_supplier — find an ES Verifactu or IT Smart Receipts supplier in Invopop by its tax ID

Usage:
  lookup_invopop_supplier [flags] <TAX_ID>

Arguments:
  TAX_ID                 the supplier's tax ID (an ES NIF, an IT partita IVA), with or
                         without the country in front, however it is spaced. Asked
                         for on a terminal when left out.

Flags:
  -r, --regime NAME      verifactu (ES) or smart_receipts (IT). Asked for on a
                         terminal when left out; required everywhere else
  -f, --folder NAME      the silo folder suppliers live in (default ${SUPPLIERS_FOLDER})
      --scan N           how many entries to read when the search finds nothing and
                         the whole folder is read instead (default 2000)
      --base-url URL     Invopop API base URL (default ${DEFAULT_BASE_URL})
      --db, --no-db      also look the supplier up in Snowflake Postgres through the
                         Metabase CLI: the regime's plugin that registered it and
                         the status Fresha holds. Asked for on a terminal when
                         neither is given.
      --mb-database N    Metabase database id to query (default ${MB_DATABASE})
      --json             emit JSON instead of a report; never prompts
  -h, --help             show this help

The token comes from the regime's variable — ${Object.entries(REGIMES).map(([k, r]) => `${r.token} (${k})`).join(", ")} — and is
asked for with the echo off when that is unset. \`ops secrets set <NAME>\` saves it
so the question is asked once.

Exit codes: 0 the supplier was found and its newest entry is not in an error state,
1 it was not found or its newest entry is in one, 2 the call was wrong or the token
was refused.
`;
}

function parseArgs(argv) {
  const o = { regime: null, folder: SUPPLIERS_FOLDER, scan: 2000, db: null, mbDatabase: MB_DATABASE, baseUrl: process.env.INVOPOP_API_BASE_URL || DEFAULT_BASE_URL, json: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { process.stdout.write(usage()); process.exit(0); }
    else if (a === "-r" || a === "--regime") o.regime = argv[++i];
    else if (a === "-f" || a === "--folder") o.folder = argv[++i];
    else if (a === "--scan") o.scan = Number(argv[++i]);
    else if (a === "--base-url") o.baseUrl = argv[++i];
    else if (a === "--db") o.db = true;
    else if (a === "--no-db") o.db = false;
    else if (a === "--mb-database") o.mbDatabase = Number(argv[++i]);
    else if (a === "--json") o.json = true;
    else if (a.startsWith("-")) fail(`unknown flag: ${a}`, 2);
    else o.positional.push(a);
  }
  if (o.regime !== null && !REGIMES[o.regime]) fail(`unknown regime: ${o.regime} — one of ${Object.keys(REGIMES).join(", ")}`, 2);
  // A tax ID with a space in it arrives as two words; that is still one tax ID.
  if (o.positional.length > 1) o.positional = [o.positional.join(" ")];
  if (!o.folder) fail("--folder needs a name", 2);
  if (!Number.isInteger(o.scan) || o.scan < 1) fail("--scan must be a whole number, 1 or more", 2);
  return o;
}

function fail(message, code) {
  process.stderr.write(`${c.bad("error:")} ${message}\n`);
  process.exit(code);
}

// One readline interface for the whole process: opening one per question loses
// the queued answers on a piped stdin. Closed before the token prompt takes the
// terminal raw.
let RL = null;
function lines() {
  if (!RL) RL = readlinePromises.createInterface({ input: process.stdin, output: process.stderr });
  return RL;
}
function closeLines() {
  if (RL) RL.close();
  RL = null;
}

// One picker per choice: ↑↓ or j/k move, a number jumps, enter picks, esc stops.
// Repaints its own lines in place, cursor hidden while it draws. Copied from
// ksa_fresha_vendor_switch, on stderr because stdout is this script's data.
function choose(question, options) {
  closeLines();
  const out = process.stderr;
  const line = (o, i, at) => (i === at ? `  ${c.cmd("❯")} ${c.header(o.label)}` : `    ${o.label}`) + (o.note ? c.faint(`  · ${o.note}`) : "");
  const draw = (at, first) => {
    const frame = options.map((o, i) => `${line(o, i, at)}\x1b[K`).join("\n") + "\n";
    out.write((first ? "" : `\x1b[${options.length}A\r`) + frame);
  };
  out.write(`${c.header(question)}  ${c.faint("↑↓ move · enter picks · esc stops")}\n`);
  out.write("\x1b[?25l");
  let at = 0;
  draw(at, true);
  return new Promise((resolve) => {
    const done = (fn) => {
      process.stdin.off("data", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      out.write("\x1b[?25h");
      fn();
    };
    const onKey = (buf) => {
      const before = at;
      for (const k of buf.toString().match(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|[\s\S]/g) || []) {
        if (k === "\x1b[A" || k === "\x1bOA" || k === "k") at = (at + options.length - 1) % options.length;
        else if (k === "\x1b[B" || k === "\x1bOB" || k === "j") at = (at + 1) % options.length;
        else if (/^[1-9]$/.test(k) && Number(k) <= options.length) at = Number(k) - 1;
        else if (k === "\r" || k === "\n") {
          if (at !== before) draw(at, false);
          return done(() => resolve(options[at].value));
        } else if (k === "\x1b" || k === "\x03" || k === "\x04" || k === "q") return done(() => fail("stopped at a prompt", 2));
      }
      // A key that changes nothing on screen writes nothing.
      if (at !== before) draw(at, false);
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onKey);
  });
}

async function askMissing(opts) {
  if (opts.json || !process.stdin.isTTY) {
    if (!opts.regime) fail(`no regime given — --regime ${Object.keys(REGIMES).join(" or ")}`, 2);
    return;
  }
  if (!opts.regime) {
    opts.regime = await choose("Which regime?", Object.entries(REGIMES).map(([k, r]) => ({ value: k, label: k, note: `${r.label} · ${r.token}` })));
  }
  const taxName = REGIMES[opts.regime].taxName;
  try {
    if (!opts.positional.length) {
      const typed = (await lines().question(`Supplier tax ID (${taxName}): `)).trim();
      if (typed) opts.positional.push(typed);
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
    stderr.write(`Paste the Invopop API token for the ${REGIME.label} workspace (input hidden): `);
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
  const fromEnv = (process.env[REGIME.token] || "").trim();
  if (fromEnv) return fromEnv;
  if (json) fail(`$${REGIME.token} is unset, and --json never prompts`, 2);
  if (!process.stdin.isTTY) fail(`$${REGIME.token} is unset and there is no terminal to ask on`, 2);
  process.stderr.write(c.faint(`$${REGIME.token} is not set.\n`));
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

// List responses have varied across API versions; accept whichever array shows up,
// the way check_invopop_suppliers does.
function listOf(body) {
  if (Array.isArray(body)) return body;
  for (const k of ["list", "entries", "data", "results"]) if (Array.isArray(body?.[k])) return body[k];
  return [];
}

const PAGE = 100;

// The search is free text, so each way of writing the tax ID is asked for: the index
// matches what was stored, and a supplier stored as "ESB85905495" is not found by
// "B85905495" in every case. Candidates are judged afterwards, exactly.
async function searchSupplier(baseUrl, token, taxId, folder) {
  const bare = bareNif(taxId);
  const forms = [...new Set([String(taxId).trim(), bare, `${REGIME.country}${bare}`].filter(Boolean))];
  const seen = new Map();
  for (const q of forms) {
    for (let offset = 0; ; offset += PAGE) {
      const got = await api(baseUrl, token, "/silo/v1/search", { q, folder, limit: PAGE, offset });
      const page = got.missing ? [] : listOf(got.data);
      for (const e of page) if (e?.id && !seen.has(e.id)) seen.set(e.id, e);
      if (page.length < PAGE || offset + PAGE >= 1000) break;
    }
  }
  return [...seen.values()];
}

// The search index is eventually consistent — it has been seen half an hour behind
// — so when it finds nothing the folder itself is read. That is the authoritative
// answer, and slower, which is why it is the fallback and not the first try. The
// API keeps handing out a cursor past the last page, so a page with nothing new on
// it is what ends the walk.
async function listFolder(baseUrl, token, folder, scan) {
  const seen = new Map();
  let cursor = null;
  while (seen.size < scan) {
    const got = await api(baseUrl, token, "/silo/v1/entries", { folder, limit: PAGE, cursor });
    const page = got.missing ? [] : listOf(got.data);
    let fresh = 0;
    for (const e of page) {
      if (e?.id && !seen.has(e.id)) {
        seen.set(e.id, e);
        fresh++;
      }
    }
    const next = got.data?.next_cursor || got.data?.cursor;
    if (!fresh || !next || next === cursor) return { list: [...seen.values()], truncated: false };
    cursor = next;
  }
  return { list: [...seen.values()], truncated: true };
}

// A search hit carries the entry but not always the document, and without the
// document there is no tax ID to match on. Thin hits are fetched again by id.
const HYDRATE_CONCURRENCY = 8;

async function hydrate(baseUrl, token, entries) {
  const out = new Array(entries.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < entries.length; i = next++) {
      const e = entries[i];
      if (e?.data?.doc || e?.data?.tax_id || !e?.id) {
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

// The tax ID can sit in several places depending on how the entry was made:
// the GOBL party in data (maybe wrapped in a "doc" envelope), the snippet, or the
// entry itself. Same search order check_invopop_suppliers uses.
function unwrap(m) {
  return m && typeof m === "object" ? m.doc && typeof m.doc === "object" ? m.doc : m : {};
}

function summarise(entry) {
  const doc = unwrap(entry?.data);
  const snip = unwrap(entry?.snippet);
  const code = doc?.tax_id?.code || snip?.tax_id?.code || entry?.tax_code || snip?.tax_code || doc?.tax_code || null;
  const country = doc?.tax_id?.country || snip?.tax_id?.country || entry?.country || null;
  return {
    id: entry?.id ?? null,
    key: entry?.key ?? null,
    folder: entry?.folder ?? null,
    name: doc?.name || snip?.name || entry?.name || null,
    tax_id: normaliseTax({ country, code }),
    state: entry?.state || (entry?.draft ? "draft" : null),
    status: classify(entry),
    created_at: entry?.created_at ?? null,
    updated_at: entry?.updated_at ?? null,
    faults: (entry?.faults || []).map((f) => ({ provider: f?.provider ?? null, code: f?.code ?? null, message: f?.message ?? null })),
    links: (entry?.meta || []).filter((m) => m?.link_url).map((m) => ({ src: m?.src ?? null, key: m?.key ?? null, url: m.link_url })),
  };
}

function matches(taxId, s) {
  const want = bareNif(taxId);
  return Boolean(want) && (want === bareNif(`${s.tax_id.country || ""}${s.tax_id.code || ""}`) || want === bareNif(s.tax_id.code));
}

function newestFirst(a, b) {
  return String(b.created_at || "").localeCompare(String(a.created_at || ""));
}

function report(s, latest) {
  const out = [];
  const tag = latest ? c.faint("  (newest)") : "";
  out.push(`  ${paint(s.status, MARK[s.status])} ${paint(s.status, (s.state || "no state").padEnd(11))} ${c.faint(String(s.created_at || "").replace("T", " ").slice(0, 16))}${tag}`);
  const row = (k, v) => out.push(`      ${c.faint(k.padEnd(9))} ${v}`);
  if (s.name) row("Name", s.name);
  if (s.id) row("Entry", s.id);
  if (s.key) row("Key", s.key);
  for (const f of s.faults) {
    row("Fault", `${c.bad(f.code || "fault")}${f.provider ? c.faint(` (${f.provider})`) : ""}${f.message ? ` — ${f.message}` : ""}`);
  }
  for (const l of s.links) row("Link", `${c.cmd(l.url)}${l.src ? c.faint(` (${l.src})`) : ""}`);
  return out.join("\n");
}

function sqlQuote(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

// The same tolerance as the Invopop side, in SQL: letters and digits alone, with or
// without the country in front. PARENT_NUMBER is the plugin's tax ID and is stored however it
// was typed — lower case included — so it is normalised before it is compared.
function warehouseSql(taxId) {
  const bare = bareNif(taxId);
  const forms = [bare, `${REGIME.country}${bare}`].map(sqlQuote).join(", ");
  const norm = (col) => `REGEXP_REPLACE(UPPER(COALESCE(${col}, '')), '[^A-Z0-9]', '')`;
  return [
    "SELECT p.ID AS PLUGIN_ID, p.ACCOUNT_CONFIGURATION_ID, p.PARENT_NUMBER, p.BRANCH_NUMBER,",
    "       p.PLUGIN_STATUS, p.THIRD_PARTY_INTEGRATION_STATUS, p.IS_DEFAULT, p.PROVIDER_ID,",
    "       p.LEGAL_ENTITY_ID, p.UPDATED_AT, c.TAX_ID, c.ENABLED, c.DELETED_AT",
    `FROM ${PLUGIN_TABLE} p`,
    `LEFT JOIN ${CONFIG_TABLE} c ON c.ID = p.ACCOUNT_CONFIGURATION_ID`,
    `WHERE p.INTEGRATION = ${sqlQuote(REGIME.integration)}`,
    "  AND p._FRESHA_HARD_DELETED_AT IS NULL",
    `  AND (${norm("p.PARENT_NUMBER")} IN (${forms}) OR ${norm("c.TAX_ID")} IN (${forms}) OR ${norm("c.VAT_NUMBER")} IN (${forms}))`,
    "ORDER BY p.IS_DEFAULT DESC, p.ID",
  ].join("\n");
}

// `mb` is the Metabase CLI (`mb auth login` once). A missing or unauthenticated
// CLI is reported and stepped over: the Invopop half of the answer still stands.
function warehouseLookup(taxId, database) {
  const body = JSON.stringify({ database, type: "native", native: { query: warehouseSql(taxId) } });
  const file = path.join(os.tmpdir(), `lookup-supplier-${process.pid}.json`);
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
    const cols = out.data.cols.map((col) => col.name);
    return { rows: (out.data.rows || []).map((row) => Object.fromEntries(cols.map((col, i) => [col, row[i]]))) };
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      /* it was a temp file either way */
    }
  }
}

function reportWarehouse(rows, taxId) {
  const out = [c.header("In Fresha") + c.faint("  · Snowflake Postgres, via the Metabase CLI")];
  if (!rows.length) return out.concat(`  ${c.warn("?")} no ${REGIME.integration} plugin carries tax ID ${taxId}`).join("\n");
  for (const r of rows) {
    const st = String(r.PLUGIN_STATUS || "").toLowerCase();
    const mark = st === "enabled" ? c.ok("✓") : st === "pending" ? c.warn("…") : c.bad("✗");
    const flags = [r.IS_DEFAULT ? "default" : null, r.DELETED_AT ? c.bad("configuration deleted") : null, r.ENABLED === false ? c.warn("configuration disabled") : null].filter(Boolean).join("  ·  ");
    out.push(`  ${mark} plugin ${c.header(String(r.PLUGIN_ID))}  ${c.header(String(r.PLUGIN_STATUS || "—"))}${flags ? c.faint(`  · `) + flags : ""}`);
    const row = (k, v) => out.push(`      ${c.faint(k.padEnd(13))} ${v}`);
    row("Config", String(r.ACCOUNT_CONFIGURATION_ID));
    row("Third party", String(r.THIRD_PARTY_INTEGRATION_STATUS || "—"));
    row("Tax ID", `${r.PARENT_NUMBER || r.TAX_ID || "—"}${r.BRANCH_NUMBER ? c.faint(`  · branch ${r.BRANCH_NUMBER}`) : ""}`);
    if (r.PROVIDER_ID) row("Provider", String(r.PROVIDER_ID));
    if (r.LEGAL_ENTITY_ID) row("Legal entity", String(r.LEGAL_ENTITY_ID));
    if (r.UPDATED_AT) row("Updated", String(r.UPDATED_AT).replace("T", " ").slice(0, 16));
  }
  return out.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await askMissing(opts);
  REGIME = REGIMES[opts.regime];
  if (!opts.positional.length) fail(`no tax ID given — pass the supplier's ${REGIME.taxName}`, 2);
  const taxId = opts.positional[0];
  if (!bareNif(taxId)) fail(`"${taxId}" has no letters or digits to look up`, 2);
  const token = await resolveToken(opts.json);

  const warehouse = opts.db ? warehouseLookup(taxId, opts.mbDatabase) : null;
  if (!opts.json && warehouse?.error) ui_warn(`Snowflake lookup skipped — ${warehouse.error}`);

  const ws = await api(opts.baseUrl, token, "/access/v1/workspace");
  const workspace = ws.data || {};
  // A token for another country, or a sandbox, answers "not found" about every
  // supplier of this one. Say
  // so before the answer does.
  if (!opts.json && workspace.country && String(workspace.country).toUpperCase() !== REGIME.country) {
    ui_warn(`this token opens ${workspace.name || workspace.slug || "a workspace"} (${workspace.country}), not the ${REGIME.label} one`);
  }

  let source = "search";
  let truncated = false;
  let candidates = await searchSupplier(opts.baseUrl, token, taxId, opts.folder);
  let found = (await hydrate(opts.baseUrl, token, candidates)).map(summarise).filter((s) => matches(taxId, s));
  if (!found.length) {
    if (!opts.json) process.stderr.write(c.faint(`The search found nothing; reading the '${opts.folder}' folder itself…\n`));
    const listed = await listFolder(opts.baseUrl, token, opts.folder, opts.scan);
    source = "folder";
    truncated = listed.truncated;
    candidates = listed.list;
    found = (await hydrate(opts.baseUrl, token, candidates)).map(summarise).filter((s) => matches(taxId, s));
  }
  found.sort(newestFirst);
  const latest = found[0] || null;

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          tax_id: taxId,
          workspace: { name: workspace.name ?? null, slug: workspace.slug ?? null, country: workspace.country ?? null },
          source,
          scanned: candidates.length,
          truncated,
          status: latest ? latest.status : null,
          count: found.length,
          entries: found,
          fresha: warehouse && !warehouse.error ? warehouse.rows : null,
          fresha_error: warehouse?.error ?? null,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    if (warehouse && !warehouse.error) process.stdout.write(reportWarehouse(warehouse.rows, taxId) + "\n\n");
    const how = source === "search" ? "found by search" : `${candidates.length} folder entr${candidates.length === 1 ? "y" : "ies"} read`;
    process.stdout.write(c.header("In Invopop") + c.faint(`  · ${workspace.name || workspace.slug || "workspace"}  · ${how}`) + "\n");
    if (truncated) process.stdout.write(c.warn(`  the folder was cut off at --scan ${opts.scan}; there may be more\n`));
    if (!latest) {
      process.stdout.write(`  ${c.warn("?")} no entry in '${opts.folder}' carries tax ID ${c.header(taxId)}\n`);
      const rightWorkspace = !workspace.country || String(workspace.country).toUpperCase() === REGIME.country;
      if (!rightWorkspace) process.stdout.write(c.faint(`    The token decides the workspace — a ${REGIME.country} supplier will not be found with an ${REGIME.other} token.\n`));
      // Only worth saying when the workspace was the right one to look in.
      if (rightWorkspace && (warehouse?.rows || []).length) process.stdout.write(c.faint(`    Fresha has a ${REGIME.integration} plugin for it, so it was registered on Fresha's side but never reached Invopop.\n`));
    } else {
      const who = [taxLabel(latest.tax_id), latest.name].filter(Boolean).join("  ·  ");
      process.stdout.write(`  ${c.header(who)}  ${c.faint(`${found.length} entr${found.length === 1 ? "y" : "ies"}, newest first`)}\n\n`);
      process.stdout.write(found.map((s, i) => report(s, i === 0)).join("\n\n") + "\n");
      // An old failure followed by a success is history, not a problem — the same
      // rule check_invopop_suppliers applies.
      if (latest.status !== "error" && found.some((s) => s.status === "error")) {
        process.stdout.write(c.faint(`\n    An older entry failed, but the newest one did not — that is history, not the current state.\n`));
      }
    }
  }

  // 1 means the data is wrong: no supplier, or its newest entry is an error.
  process.exit(!latest || latest.status === "error" ? 1 : 0);
}

// Ctrl+C at a typed question rejects the readline promise: a stop, not a crash.
main().catch((err) => fail(err?.name === "AbortError" ? "stopped at a prompt" : err.stack || err.message, 2));
