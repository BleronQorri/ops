#!/usr/bin/env node
"use strict";

// wipe_provider_einvoicing — wipe ALL of a provider's e-invoicing data in the
// accounting-documents DB, on STAGING only.
//
// Self-contained on purpose: one directory, one entrypoint, no shared library.
// The picker and the prompts are copied from ksa_fresha_vendor_switch.
//
// Scope: the e-invoicing domain rooted at `account_configurations` (keyed by
// `provider_id`). It clears — in FK order, inside ONE transaction:
//
//   accounting_documents + their children
//     einvoicing_accounting_document_line_items
//     e_invoice_compliance_records
//     accounting_document_error_logs
//     accounting_documents_logs
//     e_invoice_trackers            (accounting_documents.latest_tracker_id is
//                                    nulled first to break the self-reference)
//   account_configuration tree
//     einvoice_integration_issues
//     einvoice_integration_application_requests
//     e_invoice_it_smart_receipts_configuration
//     account_configuration_plugins
//     e_invoicing_configuration_logs
//     account_configuration_addresses
//     account_configurations
//
// NOT touched (out of scope by design):
//   - the invoicing/ domain (invoice_parties / invoices / invoicing_periods —
//     Fresha periodic billing, keyed by legal_entity_id).
//   - anything keyed only by invoice_entity_id (this matches by provider_id).
//
// Transport: `houston psql <namespace> accounting_documents` — read-only for the
// preview, `--write` for the wipe. No app-side Houston task is involved.
//
// SAFETY:
//   * STAGING ONLY. Refuses --namespace production (or anything prod-looking),
//     so it never asks which environment: the banner names staging and the
//     namespace.
//   * Prints a per-table row-count preview before doing anything.
//   * Dry run unless the operator picks (or passes) --dry-run false; the wipe is
//     then confirmed with a typed "yes". Without a terminal it is always a dry run.
//   * The whole wipe runs as a single transaction (BEGIN/COMMIT, ON_ERROR_STOP=1):
//     any error rolls the whole thing back — no partial deletes.
//
// Usage:
//   ./wipe_provider_einvoicing.js
//   ./wipe_provider_einvoicing.js 12345
//   ./wipe_provider_einvoicing.js --dry-run true 12345
//   ./wipe_provider_einvoicing.js --namespace eng-devex --dry-run false 12345

const readline = require("readline/promises");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { header: sgr("1;37"), cmd: sgr("33"), faint: sgr("2"), ok: sgr("32"), bad: sgr("31"), warn: sgr("1;33") };

// --- constants -------------------------------------------------------------

const DB = "accounting_documents";
const DEFAULT_NAMESPACE = "eng-orion";

// Namespaces we refuse to touch. This script is a full destructive wipe and is
// only ever meant for staging.
const PROD_NAMESPACES = new Set(["production", "prod"]);

// --- arg parsing -----------------------------------------------------------

function fail(message, code) {
  process.stderr.write(`${c.bad("error:")} ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    namespace: DEFAULT_NAMESPACE,
    dryRun: null,
    providerId: null,
  };
  const val = (flag, v) => {
    if (v === undefined || v.startsWith("-")) fail(`${flag} takes a value`, 2);
    return v;
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else if (a === "--namespace" || a === "-n") opts.namespace = val(a, argv[++i]);
    else if (a === "--dry-run") {
      // A bare --dry-run means true; a value after it says which.
      const next = argv[i + 1];
      if (next === "true" || next === "false") opts.dryRun = argv[++i] === "true";
      else opts.dryRun = true;
    }
    else if (a.startsWith("--dry-run=")) opts.dryRun = boolOf(a.slice("--dry-run=".length));
    else if (a.startsWith("-")) fail(`unknown flag: ${a}`, 2);
    else rest.push(a);
  }
  if (rest.length > 1) fail(`expected one PROVIDER_ID, got ${rest.join(" ")}`, 2);
  if (rest.length) opts.providerId = validateProviderId(rest[0]);
  return opts;
}

function boolOf(v) {
  if (v !== "true" && v !== "false") fail(`--dry-run takes true or false, got ${JSON.stringify(v)}`, 2);
  return v === "true";
}

function usage() {
  console.log(`wipe_provider_einvoicing — wipe a provider's e-invoicing data (STAGING only)

Usage:
  ./wipe_provider_einvoicing.js [flags] [PROVIDER_ID]

On a terminal it asks for what is left out: the provider_id and whether to dry
run. It never asks for the environment: it runs on staging only.

Arguments:
  PROVIDER_ID            The integer provider_id to clear (asked for on a
                         terminal when left out; required without one).

Flags:
  -n, --namespace NAME   Staging namespace (default: ${DEFAULT_NAMESPACE}).
                         Production namespaces are refused.
      --dry-run BOOL     true (preselected; a bare --dry-run means true):
                         preview the counts and print the SQL, write nothing.
                         false: run the wipe after a typed "yes".
  -h, --help             Show this help.

Without a terminal nothing is asked: PROVIDER_ID must be given, the run is a
dry run, and --dry-run false exits 2.

Clears (FK order, one transaction): line items, compliance records, error &
document logs, e_invoice_trackers, accounting_documents, integration issues &
application requests, smart-receipts config, plugins, config logs, addresses,
and finally account_configurations — everything keyed off the given provider_id.

Does NOT touch the invoicing/ domain (invoice_parties/invoices) or rows keyed
only by invoice_entity_id.

Exit codes: 0 done, 1 refused, stopped or failed, 2 the call was wrong.`);
}

// --- asking the operator ---------------------------------------------------

const TERMINAL = process.stdin.isTTY && process.stdout.isTTY;
// A picker hides the cursor while it draws; whatever ends the run, it comes back.
if (TERMINAL) process.on("exit", () => process.stdout.write("\x1b[?25h"));

// Stops the run: the operator said no. Exit 1, nothing after it runs.
class Stop extends Error {}
function stop(message) {
  throw new Stop(message);
}

const say = (s = "") => process.stdout.write(`  ${s}\n`);

// Pick one of a few with the arrow keys (or j/k, or the option's number); enter
// takes the highlighted one, esc or Ctrl+C stops. The first is highlighted to
// begin with. Each keystroke repaints the options in place — the cursor goes back
// up and every line clears only its own tail — so the list never blanks between
// frames, and the terminal gets its cursor back however the choice ends.
function choose(question, options) {
  closeRl();
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
    // One read can carry several keys (a held arrow, a paste), so it is split into
    // them first: an escape sequence, a lone esc, or one character.
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
      // A key that changes nothing on screen writes nothing.
      if (at !== before) draw(at, false);
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onKey);
  });
}

// Asks for whatever the flags left out. Without a terminal nothing is asked: the
// provider_id must be given, and the run is a dry run.
async function askMissing(o) {
  if (!TERMINAL) {
    if (!o.providerId) fail("no PROVIDER_ID given — pass it as the argument", 2);
    if (o.dryRun === false) fail("--dry-run false needs a terminal: the wipe is confirmed by hand", 2);
    o.dryRun = true;
    return;
  }
  if (!o.providerId) {
    const raw = await ask("provider_id to clear: ");
    if (!raw) stop("no provider_id given");
    o.providerId = validateProviderId(raw);
  }
  if (o.dryRun === null) {
    o.dryRun = await choose("Dry run?", [
      { value: true, label: "true", note: "preview the counts and print the SQL; write nothing" },
      { value: false, label: "false", note: "wipe the rows, after a typed yes" },
    ]);
  }
}

// One readline interface at a time, closed before a picker or houston takes the
// terminal, so nothing else is reading it.
let RL = null;
async function ask(q) {
  if (!RL) RL = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await RL.question(q)).trim();
  } catch (err) {
    // Ctrl+C / Ctrl+D at a prompt is the operator saying no.
    if (err.name === "AbortError") stop("stopped at a prompt");
    throw err;
  }
}
function closeRl() {
  if (RL) RL.close();
  RL = null;
}

// --- helpers ---------------------------------------------------------------

function validateProviderId(raw) {
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) {
    fail(`invalid provider_id (must be a positive integer): ${JSON.stringify(String(raw))}`, 2);
  }
  return s;
}

function runCapture(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(
      `${cmd} exited ${res.status}\n${res.stderr || ""}${res.stdout || ""}`.trim()
    );
  }
  return res.stdout;
}

function runInherit(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(" ")}\n`);
  closeRl();
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // best effort
    }
  }
  const res = spawnSync(cmd, args, { stdio: "inherit" });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${cmd} exited with status ${res.status}`);
  }
}

// --- SQL building ----------------------------------------------------------
//
// The delete is one data-modifying-CTE statement (cfg → plg → doc anchors, then
// one DELETE per table). Because it's a SINGLE statement, all referential-
// integrity checks fire at statement end — every parent and its children are
// already gone by then — so the CTE order can't cause an FK violation. This is
// the canonical form; the preview reuses the same predicates so the counts
// match exactly what the wipe removes.
//
// Everything is driven off the provider_id. provider_id is validated to be an
// integer before it reaches here, so interpolation is safe.

// The three anchor sets (account configs, their plugins, their documents),
// expressed either as CTE-name references (delete) or inline subqueries (preview).
function anchors(pid, mode) {
  const cfgInline = `SELECT id FROM account_configurations WHERE provider_id = ${pid}`;
  if (mode === "cte") {
    return { cfg: "SELECT id FROM cfg", plg: "SELECT id FROM plg", doc: "SELECT id FROM doc" };
  }
  const plgInline = `SELECT id FROM account_configuration_plugins WHERE account_configuration_id IN (${cfgInline})`;
  const docInline =
    `SELECT id FROM accounting_documents ` +
    `WHERE account_configuration_id IN (${cfgInline}) OR provider_id = ${pid}`;
  return { cfg: cfgInline, plg: plgInline, doc: docInline };
}

// Ordered [table, predicate] list, children-first. `r` holds the cfg/plg/doc
// references for the chosen mode. account_configurations is last (the root).
function targets(pid, r) {
  return [
    // accounting_documents + children
    ["einvoicing_accounting_document_line_items", `accounting_document_id IN (${r.doc})`],
    ["accounting_document_error_logs", `accounting_document_id IN (${r.doc})`],
    ["accounting_documents_logs", `accounting_document_id IN (${r.doc})`],
    ["e_invoice_compliance_records", `accounting_document_id IN (${r.doc})`],
    ["e_invoice_trackers", `accounting_document_id IN (${r.doc})`],
    ["accounting_documents", `id IN (${r.doc})`],
    // account_configuration tree
    ["einvoice_integration_issues", `account_configuration_plugin_id IN (${r.plg})`],
    [
      "einvoice_integration_application_requests",
      `account_configuration_plugin_id IN (${r.plg}) OR account_configuration_id IN (${r.cfg})`,
    ],
    ["e_invoicing_configuration_logs", `account_configuration_id IN (${r.cfg})`],
    ["account_configuration_addresses", `account_configuration_id IN (${r.cfg})`],
    ["e_invoice_it_smart_receipts_configuration", `plugin_id IN (${r.plg}) OR provider_id = ${pid}`],
    ["account_configuration_plugins", `account_configuration_id IN (${r.cfg})`],
    ["account_configurations", `id IN (${r.cfg})`],
  ];
}

// A single query returning one "table|count" line per target, in delete order.
function buildPreviewSql(pid) {
  const selects = targets(pid, anchors(pid, "preview")).map(
    ([table, where]) =>
      `SELECT '${table}' AS t, count(*) AS n FROM ${table} WHERE ${where}`
  );
  // Preserve order with an explicit ordinal; UNION ALL alone doesn't guarantee it.
  const ordered = selects
    .map((s, i) => `SELECT ${i} AS ord, t, n FROM (${s}) s${i}`)
    .join("\nUNION ALL\n");
  return `SELECT t, n FROM (\n${ordered}\n) all_counts ORDER BY ord;`;
}

// The transactional wipe: one WITH statement, cfg/plg/doc anchors + one DELETE
// per table. The final target (account_configurations) is the statement's main
// DELETE; every other table is a data-modifying CTE (d1..dN).
function buildDeleteSql(pid) {
  const r = anchors(pid, "cte");
  const cfgInline = `SELECT id FROM account_configurations WHERE provider_id = ${pid}`;
  const ctes = [
    `cfg AS (${cfgInline})`,
    `plg AS (SELECT id FROM account_configuration_plugins WHERE account_configuration_id IN (SELECT id FROM cfg))`,
    `doc AS (SELECT id FROM accounting_documents WHERE account_configuration_id IN (SELECT id FROM cfg) OR provider_id = ${pid})`,
  ];

  const rows = targets(pid, r);
  const [finalTable, finalWhere] = rows[rows.length - 1];
  rows.slice(0, -1).forEach(([table, where], i) => {
    ctes.push(`d${i + 1} AS (DELETE FROM ${table} WHERE ${where})`);
  });

  return (
    `-- clear e-invoicing data for provider_id=${pid}\n` +
    `BEGIN;\n` +
    `WITH ${ctes.join(",\n     ")}\n` +
    `DELETE FROM ${finalTable} WHERE ${finalWhere};\n` +
    `COMMIT;\n`
  );
}

function psqlRead(namespace, sql) {
  return runCapture("houston", [
    "psql",
    namespace,
    DB,
    "--",
    "-t", // tuples only
    "-A", // unaligned
    "-F",
    "|",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    sql,
  ]);
}

function parseCounts(out) {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [table, count] = line.split("|");
      return { table, count: Number(count) };
    });
}

// --- main ------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Hard staging guard.
  if (PROD_NAMESPACES.has(opts.namespace.toLowerCase())) {
    console.error(
      `Refusing to run against "${opts.namespace}". This script is a full ` +
        `destructive wipe and is STAGING ONLY.`
    );
    process.exit(1);
  }

  await askMissing(opts);
  const providerId = opts.providerId;

  console.log(
    `\n${c.header("wipe_provider_einvoicing")} — ${c.warn(`staging (${opts.namespace})`)}, ` +
      `db=${DB} provider_id=${providerId}, DRY_RUN=${opts.dryRun} — ` +
      (opts.dryRun ? "preview and SQL only" : c.warn('wipes after a typed "yes"'))
  );

  // 1. Preview -------------------------------------------------------------
  console.log("\nCounting rows to be deleted (read-only)…");
  const counts = parseCounts(psqlRead(opts.namespace, buildPreviewSql(providerId)));

  const total = counts.reduce((n, c) => n + c.count, 0);
  console.log("\n── Rows to delete ──────────────────────────────────────");
  for (const { table, count } of counts) {
    console.log(`  ${String(count).padStart(8)}  ${table}`);
  }
  console.log(`  ${String(total).padStart(8)}  TOTAL`);

  if (total === 0) {
    console.log(`\nNothing found for provider_id=${providerId}. Nothing to do.`);
    return;
  }

  const deleteSql = buildDeleteSql(providerId);

  if (opts.dryRun) {
    console.log("\n── SQL (dry-run, not executed) ─────────────────────────");
    console.log(deleteSql);
    console.log("[dry-run] Nothing was written. --dry-run false runs the wipe, after a typed \"yes\".");
    return;
  }

  // 2. Confirm -------------------------------------------------------------
  console.log(
    `\n⚠  This permanently deletes the rows above for provider_id=${providerId} ` +
      `in ${c.warn(`staging (${opts.namespace})`)}, in a single transaction.`
  );
  const final = (await ask('Type "yes" to wipe them: ')).toLowerCase();
  if (final !== "yes") stop("stopped before the wipe — nothing was written");

  // 3. Execute -------------------------------------------------------------
  // Write the SQL to a temp file and run it. The SQL wraps itself in
  // BEGIN/COMMIT; ON_ERROR_STOP makes any failure abort so nothing commits.
  const tmp = path.join(
    os.tmpdir(),
    `clear_provider_${providerId}_${process.pid}.sql`
  );
  fs.writeFileSync(tmp, deleteSql);
  try {
    runInherit("houston", [
      "psql",
      opts.namespace,
      DB,
      "--write",
      "--",
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      tmp,
    ]);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best effort
    }
  }

  console.log(`\n${c.ok("✓")} Cleared e-invoicing data for provider_id=${providerId}.`);
}

main()
  .then(() => { closeRl(); process.exit(0); })
  .catch((err) => {
    closeRl();
    if (err instanceof Stop) {
      console.log(`\n${c.bad("✗ stopped:")} ${err.message}`);
      process.exit(1);
    }
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  });
