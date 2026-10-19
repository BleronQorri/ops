#!/usr/bin/env node
"use strict";

// report_invopop_workspace_health — how one Invopop workspace is doing today:
// whose it is, how its suppliers stand, what happened to the documents sent in
// the window, and why the failed ones failed — one verdict, a report, a Slack
// post.
//
// The regime is the first thing it asks (or --regime): it picks the token, and
// the token picks the workspace. One regime per run, so a timer per workspace is
// one timer per regime, and a workspace that is down does not hide the others.
//
//   1. GET /access/v1/workspace       — whose workspace this token opens
//   2. GET /silo/v1/entries?folder=suppliers — every supplier, by state
//   3. GET /silo/v1/entries?folder=invoices  — the window's documents, by state
//   4. GET /silo/v1/entries/{id}      — the errored ones again, for their faults
//
// Read-only: GETs and nothing else. The sweep, the state buckets and the
// hydrate-the-errors step are the ones audit_it_smart_receipt_errors and
// check_invopop_suppliers use, copied here on purpose — one directory, one
// entrypoint, no shared library.
//
// Self-contained on purpose. Node ≥ 20, dependency-free.

const fs = require("fs");
const path = require("path");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { header: sgr("1;37"), cmd: sgr("33"), sql: sgr("36"), faint: sgr("2"), ok: sgr("32"), bad: sgr("31"), warn: sgr("33") };

const DEFAULT_BASE_URL = "https://api.invopop.com";
const DEFAULT_CONSOLE_URL = "https://console.invopop.com";
const TIMEOUT_MS = 20000;
const PAGE = 100;
const DEFAULT_SCAN = 2000;
const DEFAULT_SINCE = "24h";
const HYDRATE_CONCURRENCY = 8;
const LIST_MAX = 25; // errored documents listed in full; the rest are counted
const SLACK_ENV = "SLACK_WEBHOOK_URL";

// Everything that differs between the regimes, in one place. Adding a workspace
// is a row here and a line in the frontmatter's secrets.
const REGIMES = {
  verifactu: { country: "ES", label: "ES Verifactu", token: "INVOPOP_ES_VERIFACTU_API_TOKEN_RO", sandbox: false },
  smart_receipts: { country: "IT", label: "IT Smart Receipts", token: "SMART_RECEIPTS_READ_ONLY_API_TOKEN", sandbox: false },
  zatca_sandbox: { country: "SA", label: "SA ZATCA sandbox", token: "INVOPOP_SA_ZATCA_SANDBOX_API_TOKEN", sandbox: true },
};

// The same buckets the other Invopop scripts use, so a state means the same
// thing whichever one shows it to you.
const OK_STATES = ["registered", "completed", "sent", "received", "paid", "accepted", "done"];
const PENDING_STATES = ["draft", "processing", "pending", "queued", "waiting"];
const ERROR_STATES = ["error", "rejected", "invalid"];
const VOIDED_STATES = ["void", "voided", "cancelled", "canceled"];
const KINDS = ["ok", "pending", "error", "voided", "unknown"];
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
  if (kind === "pending") return c.warn(text);
  return c.faint(text);
}

// A document is a GOBL bill/invoice whatever folder it sits in; an entry that
// failed before it was given a schema is kept when it is shaped like one.
const DOC_SCHEMA_RE = /\/bill\/invoice$/;
function isDoc(entry) {
  const schema = String(entry?.doc_schema || "");
  if (schema) return DOC_SCHEMA_RE.test(schema);
  const doc = entry?.data?.doc || entry?.data || entry?.snippet || {};
  return Boolean(doc?.code || doc?.series || doc?.lines || doc?.supplier);
}

const VERDICT = {
  healthy: { mark: "✓", slack: ":large_green_circle: :tada:", paint: c.ok, rank: 0 },
  degraded: { mark: "!", slack: ":large_yellow_circle: :eyes:", paint: c.warn, rank: 1 },
  broken: { mark: "✗", slack: ":red_circle: :rotating_light:", paint: c.bad, rank: 2 },
};

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

function usage() {
  return `report_invopop_workspace_health — report how one Invopop workspace is doing today

Usage:
  report_invopop_workspace_health [flags]

One regime per run: the regime picks the token, the token picks the workspace. The
report says whose workspace it is, how the suppliers stand, what happened to the
documents sent in the window, why the failed ones failed, and gives one verdict:
healthy, degraded or broken. Read-only.

Flags:
  -r, --regime NAME      ${Object.entries(REGIMES).map(([k, r]) => `${k} (${r.label})`).join(", ")}.
                         Asked for on a terminal when left out; required without one
      --since DURATION   the documents window (default ${DEFAULT_SINCE}): 24h, 3d, 1w
      --scan N           at most N entries read per folder (default ${DEFAULT_SCAN}); reaching
                         it is reported, never silent
      --report           also write a Markdown report and a CSV of the errored
                         documents to the current directory
      --notify slack     also post the summary to the Slack incoming webhook in
                         $${SLACK_ENV}; unset, the run fails before it starts.
                         slack:NAME posts to the webhook in $NAME instead, which
                         is how each workspace gets its own channel
      --json             emit JSON instead of the report; never prompts
  -h, --help             show this help

Environment:
  ${Object.values(REGIMES).map((r) => `${r.token.padEnd(36)} the ${r.label} workspace`).join("\n  ")}
  ${SLACK_ENV.padEnd(36)} the Slack incoming webhook --notify slack posts to;
  ${"".padEnd(36)} --notify slack:NAME reads $NAME instead
  INVOPOP_API_BASE_URL                 default ${DEFAULT_BASE_URL}

Verdict:
  healthy    every document in the window and every supplier is ok or pending
  degraded   a document in the window or a supplier is in error, or a sweep hit --scan
  broken     the token was refused, or every document in the window failed

Exit codes: 0 healthy, 1 degraded or broken, 2 the call was wrong or the API
could not be reached.
`;
}

function fail(message, code) {
  process.stderr.write(`${c.bad("error:")} ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const o = { regime: null, since: DEFAULT_SINCE, scan: DEFAULT_SCAN, report: false, notify: null, json: false, baseUrl: process.env.INVOPOP_API_BASE_URL || DEFAULT_BASE_URL };
  const val = (flag, v) => {
    if (v === undefined || v.startsWith("-")) fail(`${flag} takes a value`, 2);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { process.stdout.write(usage()); process.exit(0); }
    else if (a === "-r" || a === "--regime") o.regime = val(a, argv[++i]);
    else if (a.startsWith("--regime=")) o.regime = a.slice("--regime=".length);
    else if (a === "--since") o.since = val(a, argv[++i]);
    else if (a.startsWith("--since=")) o.since = a.slice("--since=".length);
    else if (a === "--scan") o.scan = Number(val(a, argv[++i]));
    else if (a === "--report") o.report = true;
    else if (a === "--notify") o.notify = val(a, argv[++i]);
    else if (a.startsWith("--notify=")) o.notify = a.slice("--notify=".length);
    else if (a === "--json") o.json = true;
    else if (a.startsWith("-")) fail(`unknown flag: ${a}`, 2);
    else fail(`unexpected argument ${JSON.stringify(a)} — the regime is --regime ${Object.keys(REGIMES).join("|")}`, 2);
  }
  if (o.regime !== null && !REGIMES[o.regime]) fail(`unknown regime: ${o.regime} — one of ${Object.keys(REGIMES).join(", ")}`, 2);
  if (!Number.isInteger(o.scan) || o.scan < PAGE) fail(`--scan takes a whole number of at least ${PAGE}`, 2);
  if (o.notify !== null) {
    const m = /^slack(?::([A-Za-z_][A-Za-z0-9_]*))?$/.exec(o.notify);
    if (!m) fail(`--notify takes slack or slack:VARIABLE, got ${JSON.stringify(o.notify)}`, 2);
    o.notify = "slack";
    o.slackEnv = m[1] || SLACK_ENV;
  }
  o.sinceMs = parseSince(o.since);
  return o;
}

function parseSince(since) {
  const m = /^(\d+)\s*(h|d|w)$/.exec(String(since).trim());
  if (!m) fail(`invalid --since value: ${since} — use forms like 24h, 3d, 1w`, 2);
  return Number(m[1]) * { h: 36e5, d: 864e5, w: 6048e5 }[m[2]];
}

// ---------------------------------------------------------------------------
// A picker, the same one the other asking scripts carry
// ---------------------------------------------------------------------------

const TERMINAL = process.stdin.isTTY && process.stdout.isTTY;
if (TERMINAL) process.on("exit", () => process.stdout.write("\x1b[?25h"));

class Stop extends Error {}

function say(s) {
  process.stdout.write(`${s}\n`);
}

function choose(question, options) {
  const out = process.stdout;
  const line = (o, i, at) => (i === at ? `  ${c.cmd("❯")} ${c.header(o.label)}` : `    ${o.label}`) + (o.note ? c.faint(`  · ${o.note}`) : "");
  const draw = (at, first) => {
    const frame = options.map((o, i) => `${line(o, i, at)}\x1b[K`).join("\n") + "\n";
    out.write((first ? "" : `\x1b[${options.length}A\r`) + frame);
  };
  say(`${c.header(question)}  ${c.faint("↑↓ move · enter picks · esc stops")}`);
  out.write("\x1b[?25l");
  let at = 0;
  draw(at, true);
  return new Promise((resolve, reject) => {
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
        } else if (k === "\x1b" || k === "\x03" || k === "\x04" || k === "q") return done(() => reject(new Stop("stopped at a prompt")));
      }
      if (at !== before) draw(at, false);
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onKey);
  });
}

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

// The token is refused → that is a finding about the workspace, not a crash, so
// `refused` comes back rather than exiting. Anything else that stops a call
// (no network, a 5xx) is exit 2: the report could not be made.
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
  if (res.status === 401 || res.status === 403) return { refused: res.status };
  if (res.status === 404) return { missing: true };
  if (!res.ok) fail(`${url.pathname} returned ${res.status}${data?.message ? ` — ${data.message}` : ""}`, 2);
  return { data };
}

// Newest first within a folder, so the cutoff can be a stopping rule. It takes a
// whole page older than the floor to stop, not the first old entry on one.
async function sweep(baseUrl, token, { folder, cutoff, scan }) {
  const list = [];
  const seen = new Set();
  let cursor = null;
  for (;;) {
    const got = await api(baseUrl, token, "/silo/v1/entries", { folder, limit: PAGE, cursor });
    if (got.refused) return { refused: got.refused, list, scanned: 0, truncated: false };
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
    if (cutoff && fresh > 0 && kept === 0) return { list, scanned: seen.size, truncated: false };
    if (seen.size >= scan) return { list, scanned: seen.size, truncated: true };
    const next = body.next_cursor || null;
    if (!next || next === cursor || fresh === 0) return { list, scanned: seen.size, truncated: false };
    cursor = next;
  }
}

// A listed entry carries no envelope and no faults; the errored ones are fetched
// again by id, a few at a time. The error count pays for it, not the sweep.
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
      out[i] = got.data ? { ...e, ...got.data } : e;
    }
  };
  await Promise.all(Array.from({ length: Math.min(HYDRATE_CONCURRENCY, entries.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// Reading an entry
// ---------------------------------------------------------------------------

function docOf(e) {
  return e?.data?.doc || e?.snippet || e?.data || {};
}

function faultsOf(e) {
  const faults = Array.isArray(e?.faults) ? e.faults : [];
  return faults.map((f) => String(f?.message || f?.code || JSON.stringify(f)).trim()).filter(Boolean);
}

// A fault message with its ids and numbers blanked, so the same complaint about
// a hundred documents groups as one.
function faultKey(msg) {
  return String(msg)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b[A-Z]{1,4}-?\d{3,}\b/g, "<number>")
    .replace(/\d+/g, "<n>")
    .slice(0, 200);
}

function number(e) {
  const d = docOf(e);
  return [d.series, d.code].filter(Boolean).join("-") || e?.id || "?";
}

function supplierName(e) {
  const d = docOf(e);
  return d?.supplier?.name || d?.name || "";
}

// A listed party carries its tax ID as snippet.country + snippet.tax_code; a
// fetched one as doc.tax_id.{country, code}; an invoice names its supplier's.
function taxId(e) {
  const d = docOf(e);
  const t = d?.supplier?.tax_id || d?.tax_id || {};
  const fromDoc = [t.country, t.code].filter(Boolean).join("");
  if (fromDoc) return fromDoc;
  const sn = e?.snippet || {};
  return sn.tax_code ? `${sn.country || ""}${sn.tax_code}` : "";
}

function consoleUrl(workspace, e) {
  const slug = workspace?.slug;
  if (!slug || !e?.folder || !e?.id) return null;
  return `${DEFAULT_CONSOLE_URL}/${slug}/silo/${e.folder}/${e.id}`;
}

function count(entries) {
  const by = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const e of entries) by[classify(e.state)]++;
  return by;
}

// The raw states too, so one the buckets do not know is named rather than lost
// in "unknown".
function states(entries) {
  const by = {};
  for (const e of entries) by[String(e.state || "(none)")] = (by[String(e.state || "(none)")] || 0) + 1;
  return Object.fromEntries(Object.entries(by).sort((a, b) => b[1] - a[1]));
}

// One supplier is registered many times over — a retry, a re-onboarding — and
// the newest entry is where it stands now. Grouped by tax ID, falling back to the
// entry id for one that names none.
function latestPerSupplier(entries) {
  const groups = new Map();
  for (const e of entries) {
    const key = taxId(e) || e.id;
    const list = groups.get(key) || [];
    list.push(e);
    groups.set(key, list);
  }
  const current = [];
  for (const list of groups.values()) {
    list.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
    current.push({ ...list[list.length - 1], entries: list.length });
  }
  return current;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

async function build(o, regime, token) {
  const out = { regime: o.regime, label: regime.label, country: regime.country, window: o.since, generated_at: new Date().toISOString(), workspace: null, token_refused: null, notes: [], suppliers: null, documents: null, faults: [], errored: [], verdict: null };

  const ws = await api(o.baseUrl, token, "/access/v1/workspace");
  if (ws.refused) {
    out.token_refused = ws.refused;
    out.notes.push(`the token was refused (${ws.refused}) — ${regime.token} does not open a workspace any more`);
    out.verdict = "broken";
    return out;
  }
  const w = ws.data || {};
  out.workspace = { id: w.id || null, name: w.name || null, slug: w.slug || null, country: w.country || null, sandbox: w.sandbox === true };
  if (out.workspace.sandbox !== regime.sandbox) out.notes.push(`the workspace is ${out.workspace.sandbox ? "" : "not "}a sandbox, which is not what the ${o.regime} regime expects`);
  if (out.workspace.country && out.workspace.country !== regime.country) out.notes.push(`the workspace country is ${out.workspace.country}, not ${regime.country}`);

  // Every supplier, no window: a supplier in error is a problem whenever it got there.
  const sup = await sweep(o.baseUrl, token, { folder: "suppliers", cutoff: null, scan: o.scan });
  if (sup.refused) {
    out.token_refused = sup.refused;
    out.verdict = "broken";
    return out;
  }
  const current = latestPerSupplier(sup.list);
  const supErr = await hydrate(o.baseUrl, token, current.filter((e) => classify(e.state) === "error"));
  out.suppliers = {
    total: current.length,
    entries: sup.list.length,
    by_state: count(current),
    states: states(current),
    scanned: sup.scanned,
    truncated: sup.truncated,
    errored: supErr.map((e) => ({ id: e.id, name: supplierName(e), tax_id: taxId(e), state: e.state, entries: e.entries, last_at: e.updated_at || e.created_at || null, faults: faultsOf(e), url: consoleUrl(out.workspace, e) })),
  };
  if (sup.truncated) out.notes.push(`the suppliers sweep stopped at --scan ${o.scan}; the counts are a floor`);

  // The window's documents.
  const cutoff = new Date(Date.now() - o.sinceMs);
  const docs = await sweep(o.baseUrl, token, { folder: "invoices", cutoff, scan: o.scan });
  const inWindow = docs.list.filter(isDoc);
  const errored = await hydrate(o.baseUrl, token, inWindow.filter((e) => classify(e.state) === "error"));
  const groups = new Map();
  for (const e of errored) {
    const faults = faultsOf(e);
    for (const f of faults.length ? faults : ["(no fault recorded)"]) {
      const k = faultKey(f);
      const g = groups.get(k) || { fault: f, count: 0, documents: [] };
      g.count++;
      if (g.documents.length < 5) g.documents.push(number(e));
      groups.set(k, g);
    }
  }
  out.documents = { total: inWindow.length, by_state: count(inWindow), states: states(inWindow), scanned: docs.scanned, truncated: docs.truncated, since: cutoff.toISOString() };
  out.faults = [...groups.values()].sort((a, b) => b.count - a.count);
  out.errored = errored.map((e) => ({ id: e.id, number: number(e), type: docOf(e)?.type || "", supplier: supplierName(e), tax_id: taxId(e), state: e.state, created_at: e.created_at || null, faults: faultsOf(e), url: consoleUrl(out.workspace, e) }));
  if (docs.truncated) out.notes.push(`the documents sweep stopped at --scan ${o.scan} before reaching the start of the window; the counts are a floor`);

  const d = out.documents.by_state;
  if (out.documents.total > 0 && d.error === out.documents.total) out.verdict = "broken";
  else if (d.error > 0 || out.suppliers.by_state.error > 0 || sup.truncated || docs.truncated) out.verdict = "degraded";
  else out.verdict = "healthy";
  return out;
}

function summaryLines(r) {
  const v = VERDICT[r.verdict];
  const lines = [];
  lines.push(`${v.mark} ${r.verdict.toUpperCase()} — ${r.label}${r.workspace ? ` · ${r.workspace.name} (${r.workspace.slug})` : ""}`);
  if (r.token_refused) lines.push(`token refused (${r.token_refused})`);
  if (r.suppliers) {
    const s = r.suppliers.by_state;
    lines.push(`suppliers: ${r.suppliers.total} — ${s.ok} ok · ${s.pending} pending · ${s.error} error · ${s.voided} voided${s.unknown ? ` · ${s.unknown} unknown` : ""}`);
    for (const e of r.suppliers.errored.slice(0, 5)) lines.push(`  ✗ ${e.name || e.id}${e.tax_id ? ` ${e.tax_id}` : ""}${e.faults.length ? ` — ${e.faults[0]}` : ""}`);
    if (r.suppliers.errored.length > 5) lines.push(`  … and ${r.suppliers.errored.length - 5} more suppliers in error`);
  }
  if (r.documents) {
    const d = r.documents.by_state;
    lines.push(`documents, last ${r.window}: ${r.documents.total} — ${d.ok} ok · ${d.pending} pending · ${d.error} error · ${d.voided} voided${d.unknown ? ` · ${d.unknown} unknown` : ""}`);
  }
  for (const f of r.faults.slice(0, 5)) lines.push(`  ${f.count}× ${f.fault}`);
  for (const n of r.notes) lines.push(`note: ${n}`);
  return lines;
}

function printReport(r) {
  const v = VERDICT[r.verdict];
  say("");
  say(`${c.header("report_invopop_workspace_health")} ${r.label} — ${v.paint(`${v.mark} ${r.verdict}`)}${r.workspace ? c.faint(` · ${r.workspace.name} (${r.workspace.slug}) · ${r.workspace.sandbox ? "sandbox" : "production"}`) : ""}`);
  for (const n of r.notes) say(`  ${c.warn("note:")} ${n}`);
  if (r.suppliers) {
    const s = r.suppliers.by_state;
    say(`\n${c.header("SUPPLIERS")}  ${r.suppliers.total} suppliers ${c.faint(`(${r.suppliers.entries} entries; the newest per tax ID decides)`)}${r.suppliers.truncated ? c.warn(" (floor)") : ""}`);
    say(`  ${KINDS.map((k) => paint(k, `${MARK[k]} ${s[k]} ${k}`)).join("   ")}${s.unknown ? c.faint(`   unknown = ${Object.entries(r.suppliers.states).filter(([st]) => classify(st) === "unknown").map(([st, n]) => `${st}×${n}`).join(", ")}`) : ""}`);
    for (const e of r.suppliers.errored.slice(0, LIST_MAX)) say(`  ${c.bad("✗")} ${e.name || e.id}${e.tax_id ? c.faint(` ${e.tax_id}`) : ""}  ${c.faint(e.state)}${e.entries > 1 ? c.faint(` · ${e.entries} entries`) : ""}${e.last_at ? c.faint(` · last tried ${day(e.last_at)}`) : ""}${e.faults.length ? `\n      ↳ ${e.faults.join("\n      ↳ ")}` : ""}`);
    if (r.suppliers.errored.length > LIST_MAX) say(c.faint(`  … and ${r.suppliers.errored.length - LIST_MAX} more`));
  }
  if (r.documents) {
    const d = r.documents.by_state;
    say(`\n${c.header("DOCUMENTS")}  last ${r.window} · ${r.documents.total} documents${r.documents.truncated ? c.warn(" (floor)") : ""}`);
    say(`  ${KINDS.map((k) => paint(k, `${MARK[k]} ${d[k]} ${k}`)).join("   ")}`);
    if (r.faults.length) {
      say(`\n${c.header("WHY THEY FAILED")}`);
      for (const f of r.faults) say(`  ${c.bad(String(f.count).padStart(4))}  ${f.fault}  ${c.faint(f.documents.join(", "))}`);
    }
    if (r.errored.length) {
      say(`\n${c.header("ERRORED DOCUMENTS")}`);
      for (const e of r.errored.slice(0, LIST_MAX)) say(`  ${c.bad("✗")} ${e.number}${e.type ? c.faint(` ${e.type}`) : ""}  ${e.supplier}${e.tax_id ? c.faint(` ${e.tax_id}`) : ""}  ${c.faint(e.created_at?.slice(0, 16).replace("T", " ") || "")}${e.url ? c.faint(`  ${e.url}`) : ""}`);
      if (r.errored.length > LIST_MAX) say(c.faint(`  … and ${r.errored.length - LIST_MAX} more — the CSV has them all`));
    }
  }
  say("");
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeReport(r) {
  const today = r.generated_at.slice(0, 10);
  const md = path.resolve(`invopop-health-${r.regime}-${today}.md`);
  const csv = path.resolve(`invopop-health-${r.regime}-${today}.csv`);
  const lines = [`# Invopop workspace health — ${r.label} — ${today}`, "", `**Verdict: ${r.verdict}**`, ""];
  if (r.workspace) lines.push(`Workspace: ${r.workspace.name} (\`${r.workspace.slug}\`) · ${r.workspace.sandbox ? "sandbox" : "production"} · country ${r.workspace.country}`, "");
  for (const n of r.notes) lines.push(`> ${n}`, "");
  const table = (title, total, by) => {
    lines.push(`## ${title}`, "", `| ok | pending | error | voided | unknown | total |`, `|---:|---:|---:|---:|---:|---:|`, `| ${by.ok} | ${by.pending} | ${by.error} | ${by.voided} | ${by.unknown} | ${total} |`, "");
  };
  if (r.suppliers) table("Suppliers", r.suppliers.total, r.suppliers.by_state);
  if (r.suppliers?.errored.length) {
    lines.push(`| Supplier | Tax ID | State | Entries | Last tried | Fault |`, `|---|---|---|---:|---|---|`);
    for (const e of r.suppliers.errored) lines.push(`| ${e.url ? `[${e.name || e.id}](${e.url})` : e.name || e.id} | ${e.tax_id} | ${e.state} | ${e.entries} | ${day(e.last_at)} | ${e.faults.join("; ").replace(/\|/g, "\\|")} |`);
    lines.push("");
  }
  if (r.documents) table(`Documents, last ${r.window}`, r.documents.total, r.documents.by_state);
  if (r.faults.length) {
    lines.push(`## Why they failed`, "", `| Count | Fault | e.g. |`, `|---:|---|---|`);
    for (const f of r.faults) lines.push(`| ${f.count} | ${f.fault.replace(/\|/g, "\\|")} | ${f.documents.join(", ")} |`);
    lines.push("");
  }
  if (r.errored.length) {
    lines.push(`## Errored documents`, "", `| Number | Type | Supplier | Tax ID | Created | Fault |`, `|---|---|---|---|---|---|`);
    for (const e of r.errored) lines.push(`| ${e.url ? `[${e.number}](${e.url})` : e.number} | ${e.type} | ${e.supplier} | ${e.tax_id} | ${e.created_at?.slice(0, 16).replace("T", " ") || ""} | ${e.faults.join("; ").replace(/\|/g, "\\|")} |`);
    lines.push("");
  }
  fs.writeFileSync(md, lines.join("\n") + "\n");
  const rows = [["number", "type", "supplier", "tax_id", "state", "created_at", "faults", "url", "id"]];
  for (const e of r.errored) rows.push([e.number, e.type, e.supplier, e.tax_id, e.state, e.created_at, e.faults.join(" | "), e.url, e.id]);
  fs.writeFileSync(csv, rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n");
  return { md, csv };
}

// Slack has no table markup, and a link inside a code block is dead text, so each
// supplier or document in error is one line with its console (silo) page as the
// link. Faults are clipped so one long complaint does not swallow the message.
const SLACK_ROWS = 40;
const SLACK_FAULT = 120;

// The day of an ISO timestamp, or nothing.
function day(iso) {
  return iso ? String(iso).slice(0, 10) : "";
}

function clip(s, n) {
  const t = String(s ?? "");
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

// Slack mrkdwn: the three characters it reads as markup are escaped, and a link
// is <url|text>; an entry without a console page is printed in bold instead.
function mrkdwn(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function slackLink(text, url) {
  return url ? `<${url}|${mrkdwn(text)}>` : `*${mrkdwn(text)}*`;
}

// One line per entry: the linked name first, the facts dot-separated, the fault
// after a dash. Empty cells are dropped rather than printed as gaps.
function slackLine(link, cells, fault) {
  return [link, ...cells.filter(Boolean)].join(" · ") + ` — ${mrkdwn(clip(fault || "(no fault recorded)", SLACK_FAULT))}`;
}

function slackRows(rows) {
  const body = rows.slice(0, SLACK_ROWS).map((r) => `• ${r}`);
  const more = rows.length > SLACK_ROWS ? [`• … and ${rows.length - SLACK_ROWS} more — the report has them all`] : [];
  return [...body, ...more].join("\n");
}

// One message to the incoming webhook: the verdict, the counts, every supplier
// in error as a line linking to its silo page, and every failed document as another.
async function notifySlack(r, url, files) {
  const v = VERDICT[r.verdict];
  const lines = [`${v.slack} *Invopop ${r.label}* — *${r.verdict}*${r.workspace ? ` · ${r.workspace.name}` : ""}`];
  if (r.token_refused) lines.push(`:lock: token refused (${r.token_refused})`);
  // Slack shortcodes, so they render as emoji whatever client reads them.
  const counts = (by) => `:white_check_mark: ${by.ok} ok · :hourglass_flowing_sand: ${by.pending} pending · :x: ${by.error} error · :no_entry_sign: ${by.voided} voided${by.unknown ? ` · :grey_question: ${by.unknown} unknown` : ""}`;
  if (r.suppliers) {
    const s = r.suppliers.by_state;
    lines.push(`:office: *Suppliers:* ${r.suppliers.total} — ${counts(s)}`);
    lines.push(slackRows(r.suppliers.errored.map((e) => slackLine(slackLink(e.name || e.id, e.url), [mrkdwn(e.tax_id), e.state, e.entries > 1 && `${e.entries} entries`, e.last_at && `last tried ${day(e.last_at)}`], e.faults.join("; ")))));
  }
  if (r.documents) {
    const d = r.documents.by_state;
    lines.push(`:receipt: *Documents, last ${r.window}:* ${r.documents.total} — ${counts(d)}`);
    lines.push(slackRows(r.errored.map((e) => slackLine(slackLink(e.number, e.url), [e.type, mrkdwn(e.supplier), mrkdwn(e.tax_id), day(e.created_at)], e.faults.join("; ")))));
  }
  for (const n of r.notes) lines.push(`:warning: _${n}_`);
  if (files) lines.push(`:page_facing_up: _${files.md}_`);
  const text = lines.filter(Boolean).join("\n");
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    fail(`Slack — ${err.message}`, 2);
  }
  if (!res.ok) fail(`Slack webhook returned ${res.status}: ${(await res.text()).slice(0, 200)}`, 2);
}

// ---------------------------------------------------------------------------

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.regime) {
    if (o.json || !TERMINAL) fail(`no regime given — --regime ${Object.keys(REGIMES).join("|")}`, 2);
    o.regime = await choose("Which workspace?", Object.entries(REGIMES).map(([k, r]) => ({ value: k, label: k, note: `${r.label} · ${r.token}` })));
  }
  const regime = REGIMES[o.regime];
  const token = (process.env[regime.token] || "").trim();
  if (!token) fail(`${regime.token} is not set — ops run asks for it, or: ops secrets set ${regime.token}`, 2);
  const slack = o.notify === "slack" ? (process.env[o.slackEnv] || "").trim() : null;
  if (o.notify === "slack" && !slack) fail(`${o.slackEnv} is not set — ops secrets set ${o.slackEnv} (a Slack incoming webhook URL)`, 2);
  if (slack && !/^https:\/\/hooks\.slack\.com\//.test(slack)) fail(`${o.slackEnv} is not a Slack incoming webhook URL (it should start with https://hooks.slack.com/)`, 2);

  if (!o.json) process.stderr.write(c.faint(`GET ${o.baseUrl}/access/v1/workspace, /silo/v1/entries (suppliers, invoices since ${o.since}) — read-only\n`));
  const r = await build(o, regime, token);
  const files = o.report ? writeReport(r) : null;
  if (o.json) process.stdout.write(JSON.stringify({ ...r, files }, null, 2) + "\n");
  else {
    printReport(r);
    if (files) say(c.faint(`report: ${files.md}\n        ${files.csv}`));
  }
  if (slack) {
    await notifySlack(r, slack, files);
    if (!o.json) say(c.faint("posted to Slack"));
  }
  return r.verdict === "healthy" ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof Stop) {
      process.stderr.write(`${c.warn("stopped:")} ${err.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`${c.bad("error:")} ${err.stack || err.message}\n`);
    process.exit(2);
  });
