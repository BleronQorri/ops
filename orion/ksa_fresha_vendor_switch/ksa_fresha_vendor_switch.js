#!/usr/bin/env node
"use strict";

// ksa_fresha_vendor_switch — walk the operator through moving Fresha's own Saudi
// entity between Comarch and Invopop (team-orion#953, #955).
//
// Self-contained on purpose: one directory, one entrypoint, no shared library.
// Copy helpers from a sibling script rather than importing them.
//
// Three modes, each a fixed order of reads, checks and houston runner tasks:
//   onboard-invopop  the one-time move of the entity to Invopop
//   to-comarch       flip the plugin to Comarch and resubmit the refused periodic invoices
//   to-invopop       flip the plugin back to Invopop after a fix
//
// Reads go through `houston psql` only; every write is a houston runner task. The
// script stops on the first failed check, before anything is written.
//
// A task's exit code is not trusted to mean the write happened: the runner's
// run/2 exits 0 whatever the task returned, so after every write the plugin (or
// the documents) are read back and the script decides from what it finds.

const { spawn, spawnSync } = require("child_process");
const readline = require("readline/promises");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { header: sgr("1;37"), cmd: sgr("33"), sql: sgr("36"), faint: sgr("2"), ok: sgr("32"), bad: sgr("31"), warn: sgr("1;33") };

const DB = "accounting_documents";
const MODES = ["onboard-invopop", "to-comarch", "to-invopop"];
// team-orion#954. Not merged when this was written; --flip-task names it if it lands
// under another name.
const FLIP_TASK = "update_account_configuration_plugin_integrator";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage() {
  return `ksa_fresha_vendor_switch — move Fresha's Saudi entity between Comarch and Invopop, one checked step at a time

Usage:
  ksa_fresha_vendor_switch [flags] <MODE>

Modes:
  onboard-invopop        the one-time move of the entity to Invopop: check a batch has
                         cleared, disable the Comarch plugin, register with a FATOORA
                         OTP, wait for the plugin to come back invopop / enabled
  to-comarch             flip the plugin to Comarch, then resubmit the refused periodic
                         invoices through it
  to-invopop             flip the plugin back to Invopop once the cause is fixed

Flags:
      --execute          run the writes, each after a typed confirmation. Without it
                         every mode reads, checks and runs the tasks' own dry runs, and
                         writes nothing
  -c, --config ID        the account configuration (default: the one SA configuration
                         with an invoice_entity_id, which is Fresha's own)
      --branch-name S    BRANCH_NAME for the registration (onboard-invopop; asked for
                         on a terminal when left out)
      --business-category S
                         BUSINESS_CATEGORY for the registration (onboard-invopop; asked
                         for on a terminal when left out)
      --flip-task NAME   the runner task that sets the integrator (default ${FLIP_TASK})
      --wait-minutes N   how long to wait for the registration webhook or the resent
                         documents (default 15)
  -n, --namespace NAME   target namespace (default production)
  -s, --service NAME     houston service (default accounting-documents-web)
  -h, --help             show this help

Every write is a houston runner task and needs --execute and a terminal. Reads go
through houston psql (VPN up, houston authenticated).

Exit codes: 0 done, 1 a check failed or the operator stopped it, 2 the call was wrong.
`;
}

function fail(message, code) {
  process.stderr.write(`${c.bad("error:")} ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const o = { mode: null, execute: false, config: null, branchName: null, businessCategory: null, flipTask: FLIP_TASK, waitMinutes: 15, namespace: "production", service: "accounting-documents-web" };
  const num = (flag, v) => {
    if (!/^\d+$/.test(String(v || ""))) fail(`${flag} takes a whole number, got ${v === undefined ? "nothing" : JSON.stringify(v)}`, 2);
    return Number(v);
  };
  const val = (flag, v) => {
    if (v === undefined || v.startsWith("-")) fail(`${flag} takes a value`, 2);
    return v;
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { process.stdout.write(usage()); process.exit(0); }
    else if (a === "--execute") o.execute = true;
    else if (a === "-c" || a === "--config") o.config = num(a, argv[++i]);
    else if (a === "--branch-name") o.branchName = val(a, argv[++i]);
    else if (a === "--business-category") o.businessCategory = val(a, argv[++i]);
    else if (a === "--flip-task") o.flipTask = val(a, argv[++i]);
    else if (a === "--wait-minutes") o.waitMinutes = num(a, argv[++i]);
    else if (a === "-n" || a === "--namespace") o.namespace = val(a, argv[++i]);
    else if (a === "-s" || a === "--service") o.service = val(a, argv[++i]);
    else if (a.startsWith("-")) fail(`unknown flag: ${a}`, 2);
    else positional.push(a);
  }
  if (positional.length !== 1) fail(`expected one mode (${MODES.join(", ")}), got ${positional.length ? positional.join(" ") : "none"}`, 2);
  if (!MODES.includes(positional[0])) fail(`unknown mode ${JSON.stringify(positional[0])} — one of ${MODES.join(", ")}`, 2);
  o.mode = positional[0];
  if (o.execute && !(process.stdin.isTTY && process.stdout.isTTY)) fail("--execute needs a terminal: every write is confirmed by hand", 2);
  return o;
}

// One readline interface at a time, closed before houston runs so nothing else is
// reading the terminal when houston asks its own questions.
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

// Stops the run: a failed check is exit 1, and nothing after it runs.
class Stop extends Error {}
function stop(message) {
  throw new Stop(message);
}

function step(title) {
  process.stdout.write(`\n${c.header(`▸ ${title}`)}\n`);
}
const say = (s = "") => process.stdout.write(`  ${s}\n`);
const good = (s) => say(`${c.ok("✓")} ${s}`);
const when = (v) => (v ? String(v).replace("T", " ").replace(/\.\d+$/, "").replace(/:\d\d$/, "") : "—");

// --- reads -----------------------------------------------------------------

// Every read is wrapped in json_agg, so psql hands back one line of JSON and no
// column ever has to be split on a separator that might be in the data.
function read(opts, label, sql) {
  process.stdout.write(c.faint(`  read: ${label}\n`));
  const wrapped = `SELECT coalesce(json_agg(q), '[]'::json) FROM (${sql}) q;`;
  const r = spawnSync("houston", ["psql", opts.namespace, DB, "--", "-t", "-A", "-X", "-v", "ON_ERROR_STOP=1", "-c", wrapped], { encoding: "utf8" });
  if (r.error) fail(r.error.code === "ENOENT" ? "houston is not on PATH" : `houston: ${r.error.message}`, 2);
  if (r.status !== 0) fail(`houston psql exited ${r.status}:\n${(r.stderr || r.stdout || "").trim()}`, 2);
  // json_agg puts a newline between elements, so the whole output is the value.
  const line = r.stdout.trim() || "[]";
  try {
    return JSON.parse(line);
  } catch {
    fail(`houston psql returned something that is not JSON: ${line.slice(0, 200)}`, 2);
  }
}

function configurationSql(opts) {
  return `SELECT c.id, c.invoice_entity_id, c.fresha_billing_entity_id, c.country_code, c.enabled,
       c.vat_number, c.tax_id, c.company_registration_number AS crn,
       p.id AS plugin_id, p.integrator, p.integration, p.plugin_status,
       p.third_party_integration_status, p.parent_number, p.branch_number, p.updated_at AS plugin_updated_at,
       a.street, a.street2, a.building_number, a.district, a.city, a.postal_code, a.country_code AS address_country
FROM account_configurations c
LEFT JOIN account_configuration_plugins p
  ON p.account_configuration_id = c.id AND p.plugin_type = 'einvoicing' AND p.is_default
LEFT JOIN LATERAL (SELECT * FROM account_configuration_addresses x WHERE x.account_configuration_id = c.id ORDER BY x.id DESC LIMIT 1) a ON true
WHERE c.deleted_at IS NULL AND c.country_code = 'SA' AND c.invoice_entity_id IS NOT NULL${opts.config !== null ? ` AND c.id = ${opts.config}` : ""}
ORDER BY c.id`;
}

// Fresha's own entity is the SA configuration keyed on an invoice_entity_id rather
// than a provider. There is one; if that ever stops being true, --config says which.
function readConfiguration(opts) {
  const rows = read(opts, "the Fresha KSA configuration and its default e-invoicing plugin", configurationSql(opts));
  if (!rows.length) fail(opts.config !== null ? `configuration ${opts.config} is not a live SA configuration of a Fresha entity` : "no live SA configuration with an invoice_entity_id — nothing to switch", 2);
  if (rows.length > 1) fail(`${rows.length} SA configurations belong to a Fresha entity (${rows.map((r) => r.id).join(", ")}) — pass --config`, 2);
  const cfg = rows[0];
  if (!cfg.plugin_id) stop(`configuration ${cfg.id} has no default e-invoicing plugin`);
  if (cfg.integration !== "zatca") stop(`the plugin of configuration ${cfg.id} is for ${cfg.integration}, not zatca`);
  return cfg;
}

function readPlugin(opts, cfg) {
  return read(opts, "the plugin", `SELECT id AS plugin_id, integrator, integration, plugin_status, third_party_integration_status, updated_at AS plugin_updated_at
FROM account_configuration_plugins WHERE id = ${Number(cfg.plugin_id)}`)[0];
}

function readPluginLog(opts, cfg, afterId = 0) {
  return read(opts, "the plugin log", `SELECT id, status, metadata, created_at FROM e_invoicing_configuration_logs
WHERE account_configuration_id = ${Number(cfg.id)} AND id > ${Number(afterId)} ORDER BY id`);
}

function lastLogId(opts, cfg) {
  const r = read(opts, "the last plugin log line", `SELECT coalesce(max(id), 0) AS id FROM e_invoicing_configuration_logs WHERE account_configuration_id = ${Number(cfg.id)}`);
  return Number(r[0].id);
}

// A registration the onboarding task started: a `register` request carrying the
// Silo entry it created. Approved means ZATCA has the entity through Invopop.
function readRegistrations(opts, cfg) {
  return read(opts, "the entity's registration requests", `SELECT id, status, external_correlation_id, error_reason, account_configuration_plugin_id, created_at, updated_at
FROM einvoice_integration_application_requests
WHERE account_configuration_id = ${Number(cfg.id)} AND application_type = 'register' ORDER BY id DESC`);
}

// The entity's documents whose latest attempt is not settled at ZATCA. A document
// with no tracker at all counts: it was never sent.
function readUnsettledDocuments(opts, cfg) {
  return read(opts, "documents not yet sent / approved", `SELECT d.id, d.receipt_number, d.document_type, d.created_at,
       t.id AS tracker_id, t.upload_status, t.review_status, t.updated_at AS tracker_updated_at
FROM accounting_documents d
LEFT JOIN e_invoice_trackers t ON t.id = d.latest_tracker_id
WHERE d.account_configuration_id = ${Number(cfg.id)} AND d.deleted_at IS NULL
  AND d.document_type IN ('invoice', 'credit_note')
  AND NOT coalesce(t.upload_status = 'sent' AND t.review_status IN ('approved', 'approved_with_warnings'), false)
ORDER BY d.id`);
}

// Periodic invoices are keyed on the Fresha billing entity through the seller party.
function periodicSql(cfg, where) {
  return `SELECT i.id, i.document_type, i.invoice_date, i.created_at,
       p.acquired_reference, p.e_invoice_requested_at, p.e_invoice_rejected_at,
       d.id AS document_id, d.receipt_number,
       t.id AS tracker_id, t.upload_status, t.review_status
FROM invoices i
JOIN invoice_parties sp ON sp.id = i.seller_party_id
JOIN invoice_issuance_processes p ON p.invoice_id = i.id
LEFT JOIN accounting_documents d ON d.einvoice_reference = i.id::text AND d.deleted_at IS NULL
LEFT JOIN e_invoice_trackers t ON t.id = d.latest_tracker_id
WHERE sp.party_type = 'fresha_billing_entity' AND sp.external_id = '${Number(cfg.fresha_billing_entity_id)}'
  AND i.state = 'draft' AND p.e_invoice_required AND ${where}
ORDER BY i.invoice_date, i.id`;
}

function readWaitingInvoices(opts, cfg) {
  return read(opts, "periodic invoices waiting for submission", periodicSql(cfg, "p.e_invoice_requested_at IS NULL"));
}

function readRefusedInvoices(opts, cfg) {
  return read(opts, "refused periodic invoices", periodicSql(cfg, "p.e_invoice_rejected_at IS NOT NULL"));
}

function dbNow(opts) {
  return read(opts, "the database clock", "SELECT (now() AT TIME ZONE 'utc')::timestamp(0) AS now")[0].now;
}

// --- writes ----------------------------------------------------------------

function taskArgs(opts, task, params) {
  return ["task", "run", opts.service, "--namespace", opts.namespace, task, ...params.flatMap((p) => ["-p", p]), "--no-tui", "-w"];
}

// The OTP is single use and an hour long, but there is no reason to print it.
const shown = (args) => args.map((a) => (a.startsWith("OTP=") ? "OTP=******" : /[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ");

// Runs a houston task with the terminal handed over, streaming its output as it
// comes and keeping a copy so the caller can read what the task said.
function houston(opts, task, params) {
  const args = taskArgs(opts, task, params);
  process.stdout.write(`\n  ${c.cmd(`$ houston ${shown(args)}`)}\n\n`);
  closeRl();
  return new Promise((resolve) => {
    const child = spawn("houston", args, { stdio: ["inherit", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => { out += b; process.stdout.write(b); });
    child.stderr.on("data", (b) => { out += b; process.stderr.write(b); });
    child.on("error", (e) => resolve({ code: 2, out: e.message }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

// A task's own dry run. It writes nothing, so it needs no --execute.
function dryRunTask(opts, task, params) {
  return houston(opts, task, params);
}

// A write: planned only without --execute, otherwise confirmed by a typed "yes".
async function writeTask(opts, what, task, params) {
  if (!opts.execute) {
    process.stdout.write(`\n  ${c.warn("would run")} ${what}:\n  ${c.cmd(`houston ${shown(taskArgs(opts, task, params))}`)}\n`);
    return null;
  }
  const where = opts.namespace === "production" ? c.bad("PRODUCTION") : c.warn(opts.namespace);
  process.stdout.write(`\n  ${c.warn("about to")} ${what} in ${where}:\n  ${c.cmd(`houston ${shown(taskArgs(opts, task, params))}`)}\n`);
  const answer = (await ask(`  Type "yes" to run it: `)).toLowerCase();
  if (answer !== "yes") stop(`stopped before ${what} — nothing was run`);
  return houston(opts, task, params);
}

// --- shared checks ---------------------------------------------------------

function describePlugin(p) {
  return `plugin ${p.plugin_id}: ${c.header(p.integrator)} / ${c.header(p.plugin_status)}${c.faint(` · third party ${p.third_party_integration_status} · updated ${when(p.plugin_updated_at)}`)}`;
}

function requirePlugin(p, integrator, status) {
  say(describePlugin(p));
  if (p.integrator !== integrator || p.plugin_status !== status) stop(`the plugin is ${p.integrator} / ${p.plugin_status}, not ${integrator} / ${status}`);
  good(`${integrator} / ${status}`);
}

function listRows(rows, render, limit = 10) {
  for (const r of rows.slice(0, limit)) say(`  ${render(r)}`);
  if (rows.length > limit) say(c.faint(`  … ${rows.length - limit} more`));
}

const docLine = (d) => `document ${d.id} ${d.receipt_number || "(no number)"} ${d.document_type}  ${d.tracker_id ? `tracker ${d.tracker_id} ${d.upload_status} / ${d.review_status}` : "no tracker"}${c.faint(`  · ${when(d.tracker_updated_at || d.created_at)}`)}`;
const invoiceLine = (i) => `${i.id}  ${i.document_type} ${String(i.invoice_date).slice(0, 10)}${i.receipt_number ? `  ${i.receipt_number}` : ""}${i.tracker_id ? `  tracker ${i.tracker_id} ${i.upload_status} / ${i.review_status}` : ""}${i.e_invoice_rejected_at ? c.faint(`  · refused ${when(i.e_invoice_rejected_at)}`) : ""}`;

function showPluginLog(lines) {
  for (const l of lines) say(`  log ${l.id}  ${l.status}${c.faint(`  ${JSON.stringify(l.metadata || {})}  · ${when(l.created_at)}`)}`);
}

// The flip (team-orion#954): dry run, then the write, then read back the plugin and
// the log line the update function must have written.
async function flip(opts, cfg, integrator) {
  step(`Flip the integrator to ${integrator}`);
  const base = [`ACCOUNT_CONFIGURATION_ID=${cfg.id}`, `INTEGRATOR=${integrator}`];
  const dry = await dryRunTask(opts, opts.flipTask, [...base, "DRY_RUN=true"]);
  if (dry.code !== 0) stop(`the dry run of ${opts.flipTask} failed (exit ${dry.code}) — read its output above`);
  good("the dry run went through");

  const before = lastLogId(opts, cfg);
  const run = await writeTask(opts, `set the integrator of plugin ${cfg.plugin_id} to ${integrator}`, opts.flipTask, [...base, "DRY_RUN=false"]);
  if (!run) return false;
  if (run.code !== 0) stop(`${opts.flipTask} exited ${run.code} — read its output above`);

  const after = readPlugin(opts, cfg);
  say(describePlugin(after));
  if (after.integrator !== integrator) stop(`the plugin is still ${after.integrator} — the flip did not happen`);
  if (after.plugin_status !== "enabled") stop(`the plugin is now ${after.plugin_status}, not enabled — the flip must not change the status`);
  const lines = readPluginLog(opts, cfg, before);
  showPluginLog(lines);
  if (!lines.length) stop("the integrator changed but no plugin log line was written");
  good(`${integrator} / enabled, ${lines.length} new log line${lines.length === 1 ? "" : "s"}`);
  return true;
}

// --- modes -----------------------------------------------------------------

async function onboardInvopop(opts) {
  step("Read the Fresha configuration and its plugin");
  const cfg = readConfiguration(opts);
  say(`configuration ${c.header(cfg.id)}${c.faint(` · invoice entity ${cfg.invoice_entity_id} · Fresha billing entity ${cfg.fresha_billing_entity_id ?? "—"}`)}`);
  requirePlugin(cfg, "comarch", "enabled");
  if (!cfg.fresha_billing_entity_id) stop("the configuration has no fresha_billing_entity_id — the onboarding task needs one");

  step("Check the last batch has cleared");
  const unsettled = readUnsettledDocuments(opts, cfg);
  if (unsettled.length) {
    say(c.bad(`${unsettled.length} document(s) are not sent / approved:`));
    listRows(unsettled, docLine);
    stop("wait until every document is sent / approved at ZATCA");
  }
  good("every document is sent / approved");
  const waiting = readWaitingInvoices(opts, cfg);
  if (waiting.length) {
    say(c.bad(`${waiting.length} periodic invoice(s) wait for submission:`));
    listRows(waiting, invoiceLine);
    stop("a batch is on its way — wait until it has been submitted and cleared");
  }
  good("no periodic invoice waits for submission");

  if (!opts.branchName && process.stdin.isTTY) opts.branchName = await ask("  BRANCH_NAME for the registration (as ZATCA should show it): ");
  if (!opts.businessCategory && process.stdin.isTTY) opts.businessCategory = await ask("  BUSINESS_CATEGORY for the registration: ");
  if (!opts.branchName || !opts.businessCategory) fail("onboard-invopop needs --branch-name and --business-category", 2);
  const params = [`INVOICE_ENTITY_ID=${cfg.invoice_entity_id}`, `FRESHA_BILLING_ENTITY_ID=${cfg.fresha_billing_entity_id}`, `BRANCH_NAME=${opts.branchName}`, `BUSINESS_CATEGORY=${opts.businessCategory}`];

  // The task refuses an enabled plugin before it plans anything else, so while the
  // Comarch plugin is on, `already_onboarded` is the answer that means the billing
  // entity was read from Partners without a fault. Anything else is a real refusal.
  step("Dry-run the onboarding while Comarch is still on");
  const early = await dryRunTask(opts, "onboard_fresha_entity_to_ksa", [...params, "DRY_RUN=true"]);
  if (early.code !== 0 && !/disable it first|already_onboarded/.test(early.out)) stop("the onboarding dry run refused the entity — read its output above; nothing was changed");
  good("the Fresha billing entity reads cleanly from Partners");

  step("What Comarch holds for the entity");
  say(`VAT number  ${c.header(cfg.vat_number || cfg.tax_id || "—")}`);
  say(`CRN         ${c.header(cfg.crn || "—")}`);
  say(`address     ${[cfg.street, cfg.street2, cfg.building_number && `building ${cfg.building_number}`, cfg.district, cfg.postal_code, cfg.city, cfg.address_country].filter(Boolean).join(", ") || "—"}`);
  say(c.faint("The onboarding registers the party from the Fresha billing entity in Partners. ZATCA must see one"));
  say(c.faint("supplier: check that entity's VAT number, CRN and address against the lines above."));
  if (opts.execute) {
    const same = (await ask(`  Does the Partners billing entity match what Comarch holds? Type "yes": `)).toLowerCase();
    if (same !== "yes") stop("the party does not match — fix the billing entity in Partners first; nothing was changed");
  }

  step("Disable the Comarch plugin");
  say(c.faint("The router skips Fresha documents while the plugin is not enabled, so keep this window short."));
  const disabled = await writeTask(opts, `disable plugin ${cfg.plugin_id}`, "update_account_configuration_plugin_status", [`ACCOUNT_CONFIGURATION_ID=${cfg.id}`, "PLUGIN_STATUS=disabled", "THIRD_PARTY_INTEGRATION_STATUS=disabled"]);
  if (!disabled) {
    say(c.faint("\n  Then: the onboarding dry run again, a FATOORA OTP, the onboarding for real, and a wait for the webhook."));
    return 0;
  }
  const off = readPlugin(opts, cfg);
  say(describePlugin(off));
  if (off.plugin_status !== "disabled" || off.third_party_integration_status !== "disabled") stop("the plugin is not disabled — read the task's output above");
  good("comarch / disabled");

  // From here the plugin is off. A stop leaves it off, so offer it back on while
  // it is still Comarch's; once the task has re-pointed it, it is not.
  try {
    step("Dry-run the onboarding again");
    const dry = await dryRunTask(opts, "onboard_fresha_entity_to_ksa", [...params, "DRY_RUN=true"]);
    if (dry.code !== 0) stop("the onboarding dry run refused the entity — read its output above");
    if (!/re-register account configuration/.test(dry.out)) say(c.warn("the dry run did not say it would re-register this configuration — read its output above"));
    good("the dry run plans the registration");

    step("Register with ZATCA through Invopop");
    say(c.faint("Generate an OTP in the FATOORA portal now; it lasts an hour."));
    let otp = "";
    while (!/^\d{6}$/.test(otp)) {
      otp = await ask("  FATOORA OTP (six digits, empty to stop): ");
      if (!otp) stop("no OTP given");
    }
    const run = await writeTask(opts, "register the entity with ZATCA through Invopop", "onboard_fresha_entity_to_ksa", [...params, `OTP=${otp}`, "DRY_RUN=false"]);
    if (run.code !== 0) stop(`the onboarding exited ${run.code} — read its output above; an OTP ZATCA refused is recovered by running this mode again with a fresh one`);
  } catch (err) {
    const now = readPlugin(opts, cfg);
    if (err instanceof Stop && now.integrator === "comarch" && now.plugin_status === "disabled") {
      say(c.warn(`\n  ${err.message}`));
      say(c.warn("  The Comarch plugin is still disabled, so Fresha documents are not being sent."));
      await writeTask(opts, `enable plugin ${cfg.plugin_id} again on Comarch`, "update_account_configuration_plugin_status", [`ACCOUNT_CONFIGURATION_ID=${cfg.id}`, "PLUGIN_STATUS=enabled", "THIRD_PARTY_INTEGRATION_STATUS=enabled"]).catch(() => null);
      say(describePlugin(readPlugin(opts, cfg)));
    }
    throw err;
  }

  step("Wait for the registration webhook");
  const deadline = Date.now() + opts.waitMinutes * 60000;
  for (;;) {
    const p = readPlugin(opts, cfg);
    if (p.integrator === "invopop" && p.plugin_status === "enabled") {
      say(describePlugin(p));
      good("registered: invopop / enabled");
      return 0;
    }
    if (p.plugin_status === "failed") {
      say(describePlugin(p));
      const [req] = readRegistrations(opts, cfg);
      if (req) say(c.bad(`registration request ${req.id} ${req.status}: ${JSON.stringify(req.error_reason || {})}`));
      stop("ZATCA refused the registration through Invopop — the plugin is failed");
    }
    if (Date.now() > deadline) {
      say(describePlugin(p));
      stop(`no verdict in ${opts.waitMinutes} minutes — run to-invopop's checks later, or look up the Silo entry`);
    }
    say(c.faint(`${p.integrator} / ${p.plugin_status} — checking again in 15s`));
    await new Promise((r) => setTimeout(r, 15000));
  }
}

async function toComarch(opts) {
  step("Read the Fresha configuration and its plugin");
  const cfg = readConfiguration(opts);
  say(`configuration ${c.header(cfg.id)}`);
  requirePlugin(cfg, "invopop", "enabled");
  if (!cfg.fresha_billing_entity_id) stop("the configuration has no fresha_billing_entity_id — its periodic invoices cannot be found");

  const flipped = await flip(opts, cfg, "comarch");

  step("Refused periodic invoices");
  const refused = readRefusedInvoices(opts, cfg);
  if (!refused.length) {
    good("none — nothing to resubmit");
    say(c.faint("Documents that failed before the send are picked up by the retry cron, through Comarch now."));
    return 0;
  }
  refused.forEach((r, i) => say(`${String(i + 1).padStart(3)}  ${invoiceLine(r)}`));
  let selected = refused;
  if (opts.execute) {
    const out = await ask("  Leave any out? Their numbers, comma-separated (Enter for none): ");
    const drop = new Set(out.split(",").map((s) => s.trim()).filter(Boolean).map(Number));
    if ([...drop].some((n) => !Number.isInteger(n) || n < 1 || n > refused.length)) stop(`not a number in the list: ${out}`);
    selected = refused.filter((_, i) => !drop.has(i + 1));
    if (!selected.length) stop("every invoice was left out — nothing to resubmit");
  }
  const ids = selected.map((r) => r.id);
  if (!ids.every((id) => UUID.test(id))) fail("an invoice id is not a UUID", 2);

  step(`Resubmit ${ids.length} invoice(s)`);
  // The task's own default is DRY_RUN=false, so it is always passed.
  const dry = await dryRunTask(opts, "resubmit_einvoice_for_periodic_invoices", [`INVOICE_IDS=${ids.join(",")}`, "DRY_RUN=true"]);
  if (dry.code !== 0) stop(`the resubmit dry run exited ${dry.code} — read its output above`);
  if (!flipped) {
    say(c.faint("\n  After the flip, the resubmit would run for real:"));
    await writeTask(opts, `resubmit ${ids.length} refused invoice(s) through Comarch`, "resubmit_einvoice_for_periodic_invoices", [`INVOICE_IDS=${ids.join(",")}`, "DRY_RUN=false"]);
    return 0;
  }
  const started = dbNow(opts);
  const run = await writeTask(opts, `resubmit ${ids.length} refused invoice(s) through Comarch`, "resubmit_einvoice_for_periodic_invoices", [`INVOICE_IDS=${ids.join(",")}`, "DRY_RUN=false"]);
  if (run.code !== 0) stop(`the resubmit exited ${run.code} — read its output above`);

  step("Tracker states of the resubmitted documents");
  return reportResubmitted(opts, ids, started);
}

// The router reuses the document row and opens a new tracker next to the refused
// one, so the attempt made by this run is a tracker created since it started.
async function reportResubmitted(opts, ids, started) {
  const list = ids.map((id) => `'${id}'`).join(", ");
  const sql = `SELECT i.id AS invoice_id, d.id AS document_id, d.receipt_number,
       t.id AS tracker_id, t.upload_status, t.review_status, t.created_at, t.updated_at
FROM invoices i
LEFT JOIN accounting_documents d ON d.einvoice_reference = i.id::text AND d.deleted_at IS NULL
LEFT JOIN LATERAL (SELECT * FROM e_invoice_trackers x WHERE x.accounting_document_id = d.id AND x.created_at >= '${started}' ORDER BY x.id DESC LIMIT 1) t ON true
WHERE i.id IN (${list}) ORDER BY i.id`;
  const settled = (r) => r.tracker_id && (["approved", "approved_with_warnings", "rejected", "failed"].includes(r.review_status) || ["rejected", "failed_to_send"].includes(r.upload_status));
  const deadline = Date.now() + opts.waitMinutes * 60000;
  let rows = read(opts, "the new trackers", sql);
  while (!rows.every(settled) && Date.now() < deadline) {
    say(c.faint(`${rows.filter(settled).length} of ${rows.length} have a verdict — checking again in 30s`));
    await new Promise((r) => setTimeout(r, 30000));
    rows = read(opts, "the new trackers", sql);
  }
  for (const r of rows) {
    const ok = ["approved", "approved_with_warnings"].includes(r.review_status);
    const bad = settled(r) && !ok;
    const mark = !r.tracker_id ? c.bad("✗") : ok ? c.ok("✓") : bad ? c.bad("✗") : c.sql("…");
    say(`${mark} ${r.invoice_id}  ${r.receipt_number || ""}  ${r.tracker_id ? `tracker ${r.tracker_id} ${r.upload_status} / ${r.review_status}` : "no new tracker — it was not resent"}`);
  }
  const failed = rows.filter((r) => !r.tracker_id || (settled(r) && !["approved", "approved_with_warnings"].includes(r.review_status)));
  if (!rows.every(settled)) say(c.faint(`\n  Some have no verdict after ${opts.waitMinutes} minutes; lookup_sa_zatca_document follows one up.`));
  return failed.length ? 1 : 0;
}

async function toInvopop(opts) {
  step("Read the Fresha configuration and its plugin");
  const cfg = readConfiguration(opts);
  say(`configuration ${c.header(cfg.id)}`);
  requirePlugin(cfg, "comarch", "enabled");

  step("Check the entity is registered through Invopop");
  const regs = readRegistrations(opts, cfg);
  const approved = regs.find((r) => r.status === "approved" && UUID.test(String(r.external_correlation_id || "")));
  if (!approved) {
    if (regs.length) listRows(regs, (r) => `request ${r.id} ${r.status}  ${r.external_correlation_id || "no Silo entry"}${c.faint(`  · ${when(r.created_at)}`)}`);
    stop("the entity has no approved Invopop registration — run onboard-invopop, not to-invopop");
  }
  good(`registration request ${approved.id} approved${c.faint(` · Silo entry ${approved.external_correlation_id} · ${when(approved.updated_at)}`)}`);
  say(c.faint("Do not run the onboarding again: the registration stands."));

  await flip(opts, cfg, "invopop");
  return 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const where = opts.namespace === "production" ? c.bad("production") : c.warn(opts.namespace);
  process.stdout.write(`${c.header("ksa_fresha_vendor_switch")} ${opts.mode} — ${where}, ${opts.execute ? c.warn("writes on confirmation") : "dry run: reads, checks and task dry runs only"}\n`);
  const run = { "onboard-invopop": onboardInvopop, "to-comarch": toComarch, "to-invopop": toInvopop }[opts.mode];
  const code = await run(opts);
  if (!opts.execute) process.stdout.write(`\n${c.faint("Dry run: nothing was written. --execute runs the writes, each after a confirmation.")}\n`);
  return code;
}

main()
  .then((code) => { closeRl(); process.exit(code); })
  .catch((err) => {
    closeRl();
    if (err instanceof Stop) {
      process.stdout.write(`\n${c.bad("✗ stopped:")} ${err.message}\n`);
      process.exit(1);
    }
    process.stderr.write(c.bad(`error: ${err.stack || err.message}\n`));
    process.exit(2);
  });
