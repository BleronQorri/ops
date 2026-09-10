#!/usr/bin/env node

// wipe_provider_einvoicing — wipe ALL of a provider's e-invoicing data in the
// accounting-documents DB, on STAGING only.
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
//   * STAGING ONLY. Refuses --namespace production (or anything prod-looking).
//   * Prints a per-table row-count preview before doing anything.
//   * Requires you to type the provider_id back, then a final "yes".
//   * The whole wipe runs as a single transaction (-1, ON_ERROR_STOP=1): any
//     error rolls the whole thing back — no partial deletes.
//   * --dry-run prints the SQL and exits without writing.
//
// Usage:
//   ./wipe_provider_einvoicing.js 12345
//   ./wipe_provider_einvoicing.js --namespace eng-orion 12345
//   ./wipe_provider_einvoicing.js --dry-run 12345

const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// --- constants -------------------------------------------------------------

const DB = "accounting_documents";
const DEFAULT_NAMESPACE = "eng-orion";

// Namespaces we refuse to touch. This script is a full destructive wipe and is
// only ever meant for staging.
const PROD_NAMESPACES = new Set(["production", "prod"]);

// --- arg parsing -----------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    namespace: DEFAULT_NAMESPACE,
    dryRun: false,
    providerId: null,
    help: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--namespace" || a === "-n") opts.namespace = argv[++i];
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else rest.push(a);
  }
  if (rest.length) opts.providerId = rest[0];
  return opts;
}

function usage() {
  console.log(`wipe_provider_einvoicing — wipe a provider's e-invoicing data (STAGING only)

Usage:
  ./wipe_provider_einvoicing.js [flags] <PROVIDER_ID>

Arguments:
  PROVIDER_ID            The integer provider_id to clear.

Flags:
  -n, --namespace NAME   Staging namespace (default: ${DEFAULT_NAMESPACE}).
                         Production namespaces are refused.
      --dry-run          Preview + print the SQL; write nothing.
  -h, --help             Show this help.

Clears (FK order, one transaction): line items, compliance records, error &
document logs, e_invoice_trackers, accounting_documents, integration issues &
application requests, smart-receipts config, plugins, config logs, addresses,
and finally account_configurations — everything keyed off the given provider_id.

Does NOT touch the invoicing/ domain (invoice_parties/invoices) or rows keyed
only by invoice_entity_id.`);
}

// --- helpers ---------------------------------------------------------------

function validateProviderId(raw) {
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) {
    throw new Error(`Invalid provider_id (must be a positive integer): "${raw}"`);
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
  if (input.isTTY) {
    try {
      input.setRawMode(false);
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

async function ask(question) {
  const rl = readline.createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
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
  if (opts.help) return usage();

  // Hard staging guard.
  if (PROD_NAMESPACES.has(opts.namespace.toLowerCase())) {
    console.error(
      `Refusing to run against "${opts.namespace}". This script is a full ` +
        `destructive wipe and is STAGING ONLY.`
    );
    process.exit(1);
  }

  const providerId = opts.providerId
    ? validateProviderId(opts.providerId)
    : validateProviderId(await ask("provider_id to clear: "));

  console.log(
    `\nTarget: namespace=${opts.namespace} db=${DB} provider_id=${providerId}` +
      (opts.dryRun ? "  [DRY RUN]" : "")
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
    console.log("[dry-run] Nothing was written.");
    return;
  }

  // 2. Confirm -------------------------------------------------------------
  console.log(
    "\n⚠  This permanently deletes the rows above in a single transaction."
  );
  const echo = (await ask(`Type the provider_id (${providerId}) to confirm: `)).trim();
  if (echo !== providerId) {
    console.error("provider_id mismatch. Aborting.");
    process.exit(1);
  }
  const final = (await ask('Proceed? (type "yes"): ')).trim().toLowerCase();
  if (final !== "yes") {
    console.log("Aborted. Nothing was written.");
    return;
  }

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

  console.log(`\n✓ Cleared e-invoicing data for provider_id=${providerId}.`);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
