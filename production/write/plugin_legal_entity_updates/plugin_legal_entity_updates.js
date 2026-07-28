#!/usr/bin/env node

// plugin_legal_entity_updates — link providers' e-invoicing plugins to their
// PRIMARY legal entity via `link_plugins_to_legal_entities_from_env`.
//
// INTERACTIVE BY DEFAULT: run it with no arguments and it prompts for the
// environment, which providers, and dry-run-vs-apply. Every flag is just a way
// to pre-answer one of those prompts — you never need to remember them.
//
// It resolves each provider's PRIMARY legal entity and the e-invoicing plugin
// that should point at it, prints the Houston command, and — after confirmation
// — runs it:
//
//   houston task run accounting-documents --namespace eng-orion \
//       link_plugins_to_legal_entities_from_env \
//       -p UPDATES='[{"plugin_id":1,"legal_entity_id":"3fa85f64-…"}]' \
//       -p DRY_RUN="true"
//
// The two DB reads are read-only. The task defaults to DRY_RUN="true" (log-only)
// — `--apply` is what actually writes. `--print-only` goes back to printing the
// command and stopping.
//
// SAFETY:
//   * Always prints the exact command before asking.
//   * Non-prod: one "yes". PRODUCTION: type the namespace back, THEN "yes".
//   * Writes only via `--apply` (DRY_RUN="false"); the default run is log-only.
//   * The underlying action never overwrites a non-NULL legal_entity_id, so a
//     re-run is idempotent.
//   * Verifies by reading the rows back afterwards — the task exits 0 even when
//     it skips every row, so its exit code proves nothing on its own. Any row
//     that didn't land makes this script exit 1.
//
// ## Where the data comes from
//
// `legal_entity_id` — the shedul DB, table `provider_purchases_primary_legal_entities`:
//
//   SELECT legal_entity_id FROM provider_purchases_primary_legal_entities
//   WHERE provider_id = $1 AND valid_to IS NULL
//
// That is exactly what the `get_primary_legal_entity_id_for_provider` v1 RPC does
// (app-shedul: Rpc::Action::GetPrimaryLegalEntityIdForProviderAction →
// Areas::LegalEntities.get_primary_legal_entity_for_provider_purchases). A partial
// unique index on `provider_id WHERE valid_to IS NULL` guarantees at most one
// active row; superseded rows keep `valid_to` set as a history trail. The RPC
// answers NOT_FOUND when there is no active row — here that provider is reported
// as skipped.
//
// NOTE: the table lives in the *shedul* DB, not legal-entities. Legal entities
// themselves live in app-legal-entities (no FK, cross-service), but this
// provider→primary pointer is owned by shedul.
//
// `plugin_id` — the accounting_documents DB, `account_configuration_plugins`
// joined to `account_configurations` on `provider_id`.
//
// ## Which plugin gets picked
//
// `account_configuration_plugins_legal_entity_id_uniq_index` makes
// `legal_entity_id` globally unique among plugins where it is NOT NULL, so a
// legal entity can back at most ONE plugin. This script therefore only ever
// proposes plugins whose `legal_entity_id` IS NULL, and if a provider has more
// than one such plugin it refuses to guess: the provider is skipped and every
// candidate is listed so you can decide. Plugins that already have a
// legal_entity_id are left alone (the task would skip them anyway —
// BackfillAccountConfigurationPluginLegalEntityIdAction never overwrites).
//
// FOUR MODES, picked at the first prompt. Workflow order:
//   migrate      create the legal entities (legal_entities_migration:migrate on
//                partners-app) — run FIRST; everything else depends on it
//   pre-flight   is the data consistent? (billing info vs legal entity)  READ-ONLY
//   link         resolve and run link_plugins_to_legal_entities_from_env
//   post-flight  is everything linked?   (plugin vs primary legal entity) READ-ONLY
//
// Usage:
//   ./plugin_legal_entity_updates.js                        # guided — just run it
//   ./plugin_legal_entity_updates.js --migrate 12345        # create legal entities
//   ./plugin_legal_entity_updates.js --preflight --all      # data consistency, pass/fail
//   ./plugin_legal_entity_updates.js --postflight --all     # link state, pass/fail
//   ./plugin_legal_entity_updates.js 12345,67890            # link: skip the provider prompt
//   ./plugin_legal_entity_updates.js -n production --apply 12345
//   ./plugin_legal_entity_updates.js --print-only 12345     # don't run it

const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const { spawnSync } = require("child_process");
const fs = require("fs");

// --- constants -------------------------------------------------------------

// The primary-legal-entity pointer and provider_billing_informations are owned
// by shedul; plugins live in accounting_documents; the legal entities themselves
// live in their own service.
const SHEDUL_DB = "shedul";
const AD_DB = "accounting_documents";
const LE_DB = "legal_entities";

// What provider_billing_informations (shedul) says vs what the legal entity
// (legal_entities) says. `le` lists candidate field keys in priority order —
// legal_entities stores its data as a jsonb array of {key, value}, and which key
// carries a value varies by entity type and country. tax_number, for instance,
// lands in organization.vatNumber for IT but taxInformation.number elsewhere, so
// both are checked and the first non-empty one wins.
// `only` restricts a field to one kind of legal entity. Without it we'd report
// every organization as "first name missing": provider_billing_informations
// carries a contact person's name regardless of account type, while an
// organization legal entity has no individual.* fields at all. That's a shape
// difference, not a data discrepancy, and flagging it would bury the real ones.
const FIELD_COMPARISON = [
  {
    label: "legal name",
    pbi: "company_name",
    le: ["organization.legalName", "trust.name"],
    only: "organization",
  },
  {
    label: "first name",
    pbi: "first_name",
    le: ["individual.name.firstName"],
    only: "individual",
  },
  {
    label: "last name",
    pbi: "last_name",
    le: ["individual.name.lastName"],
    only: "individual",
  },
  {
    label: "tax / VAT no.",
    pbi: "tax_number",
    le: [
      "organization.vatNumber",
      "organization.taxInformation.number",
      "trust.taxInformation.number",
    ],
  },
  {
    label: "registration no.",
    pbi: "company_registration_number",
    le: ["organization.registrationNumber", "trust.registrationNumber"],
    only: "organization",
  },
  {
    label: "activity code",
    pbi: "activity_code",
    le: ["organization.activityCode"],
    only: "organization",
  },
  {
    label: "street",
    pbi: "address",
    le: [
      "organization.registeredAddress.street",
      "individual.residentialAddress.street",
    ],
  },
  {
    label: "city",
    pbi: "city",
    le: ["organization.registeredAddress.city", "individual.residentialAddress.city"],
  },
  {
    label: "postal code",
    pbi: "postal_code",
    le: [
      "organization.registeredAddress.postalCode",
      "individual.residentialAddress.postalCode",
    ],
  },
  {
    label: "state/province",
    pbi: "state_province",
    le: [
      "organization.registeredAddress.stateOrProvince",
      "individual.residentialAddress.stateOrProvince",
    ],
  },
  {
    label: "country",
    pbi: "country_code",
    // Falls back to the legal_entities.country_code column, surfaced as a
    // pseudo-key by the query below.
    le: [
      "organization.registeredAddress.country",
      "individual.residentialAddress.country",
      "_column.country_code",
    ],
  },
  // Billing-info columns with NO legal-entity counterpart. They are listed so the
  // per-provider checklist is complete, but marked informational: "provider only"
  // is the designed state, not a discrepancy, so they never fail pre-flight.
  { label: "building number", pbi: "building_number", le: [], informational: true },
  { label: "district", pbi: "district", le: [], informational: true },
  { label: "company number", pbi: "company_number", le: [], informational: true },
];

// The provider_billing_informations columns the comparison needs, in the order
// the query selects them.
const PBI_COLUMNS = [
  "provider_id",
  "company_name",
  "first_name",
  "last_name",
  "country_code",
  "state_province",
  "city",
  "postal_code",
  "address",
  "tax_number",
  "company_registration_number",
  "activity_code",
  "building_number",
  "district",
  "company_number",
];

const DEFAULT_NAMESPACE = "eng-orion";
const DEFAULT_SERVICE = "accounting-documents";
const TASK = "link_plugins_to_legal_entities_from_env";

// Migrate mode drives a different service entirely — the migration lives in
// app-shedul (partners), not accounting-documents.
const MIGRATE_SERVICE = "partners-app";
const MIGRATE_TASK = "legal_entities_migration:migrate";

// app-shedul/src/app/models/billing_migration_status.rb
const MIGRATION_STATUSES = ["pending", "migrated", "confirmed", "failed"];

// Namespaces that get the second confirmation gate.
const PROD_NAMESPACES = new Set(["production", "prod"]);

// --- colour ------------------------------------------------------------------
//
// Same convention as onboard_location_scripts.exs: cyan for SQL, yellow for a
// command you could run yourself, bright white for section headers, faint for
// progress chatter. Off when stdout isn't a terminal, or when NO_COLOR is set
// (https://no-color.org) — so piping to a file or a pager stays clean.

const COLOR = output.isTTY && !process.env.NO_COLOR;
const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));

const c = {
  sql: sgr("36"), // cyan   — a query about to run
  cmd: sgr("33"), // yellow — a command you could run yourself
  head: sgr("1;37"), // bright white — section headers
  faint: sgr("2"), // faint  — progress
  ok: sgr("32"), // green
  bad: sgr("1;31"), // bright red
  warn: sgr("1;33"), // bright yellow
};

// A long IN(...) list would drown the terminal — --all on production is
// thousands of ids. Show enough to recognise the query, then say what was cut.
const SQL_ECHO_LIMIT = 500;

// Echo a statement before it runs, indented and cyan. Goes to the human channel
// (stderr under --json) so it never contaminates a payload.
function echoSql(label, sql) {
  const shown =
    sql.length > SQL_ECHO_LIMIT
      ? `${sql.slice(0, SQL_ECHO_LIMIT)}\n… (${sql.length - SQL_ECHO_LIMIT} more chars)`
      : sql;

  promptStream.write(`  ${c.faint(label)}\n`);
  for (const line of shown.split("\n")) promptStream.write(`    ${c.sql(line)}\n`);
}

// --- arg parsing -----------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    namespace: DEFAULT_NAMESPACE,
    service: DEFAULT_SERVICE,
    apply: false,
    json: false,
    printOnly: false,
    all: false,
    // "preflight" | "postflight" | "link" | "migrate" — null until chosen.
    mode: null,
    // Migrate-mode params. Payment methods default ON, matching how the task is
    // invoked in practice; the rest sit at the rake task's own defaults.
    migratePaymentMethods: true,
    copyTaxNumber: false,
    batchSize: null,
    // Pre-flight detail view. null = auto: full per-provider field tables when you
    // named providers yourself (you're inspecting them), compact summary for a
    // bulk --all sweep. --detail / --summary force it either way.
    detail: null,
    file: null,
    providerIds: null,
    help: false,
    // Track what was supplied so the interactive flow only asks for the rest.
    namespaceGiven: false,
    modeGiven: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--namespace" || a === "-n") {
      opts.namespace = argv[++i];
      opts.namespaceGiven = true;
    } else if (a === "--service" || a === "-s") opts.service = argv[++i];
    else if (a === "--file" || a === "-f") opts.file = argv[++i];
    else if (a === "--apply") {
      opts.apply = true;
      opts.modeGiven = true;
      opts.mode = "link";
    } else if (a === "--dry-run") {
      opts.apply = false;
      opts.modeGiven = true;
      opts.mode = "link";
    } else if (a === "--all") opts.all = true;
    else if (a === "--detail") opts.detail = true;
    else if (a === "--summary") opts.detail = false;
    else if (a === "--migrate") opts.mode = "migrate";
    else if (a === "--no-payment-methods") opts.migratePaymentMethods = false;
    else if (a === "--copy-tax-number") opts.copyTaxNumber = true;
    else if (a === "--batch-size") opts.batchSize = argv[++i];
    else if (a === "--preflight" || a === "--pre-flight") opts.mode = "preflight";
    // --verify was the old name for the link audit; kept as an alias.
    else if (a === "--postflight" || a === "--post-flight" || a === "--verify") {
      opts.mode = "postflight";
    } else if (a === "--print-only") {
      // Valid in both link and migrate, so it must NOT imply a mode — otherwise
      // it would silently answer the mode prompt for you.
      opts.printOnly = true;
    } else if (a === "--json") {
      opts.json = true;
      opts.mode = opts.mode || "link";
    } else if (a === "--help" || a === "-h") opts.help = true;
    else rest.push(a);
  }
  if (rest.length) opts.providerIds = rest.join(",");
  return opts;
}

function usage() {
  console.log(`plugin_legal_entity_updates — link plugins to their primary legal entity

Usage:
  ./plugin_legal_entity_updates.js [flags] [PROVIDER_IDS]

Run it with no arguments — it walks you through every choice. Everything below
is optional; each flag only pre-answers a prompt, so there is nothing to
remember.

Arguments:
  PROVIDER_IDS           Comma- and/or space-separated provider IDs (e.g. 123,456).
                         Omit to be asked (all providers, or a list you type).

Flags (each one just pre-answers a prompt):
  -n, --namespace NAME   Namespace / env (default: ${DEFAULT_NAMESPACE}).
                         Drives BOTH the psql env and the task's --namespace.
      --all              Every provider in account_configurations
  -f, --file PATH        Read provider IDs from a file (one per line, or any
                         comma/whitespace-separated mix; # starts a comment)
      --migrate          Run ${MIGRATE_TASK} on
                         ${MIGRATE_SERVICE}. Explicit provider list only.
      --no-payment-methods   MIGRATE_PAYMENT_METHODS=false (default true)
      --copy-tax-number      COPY_TAX_NUMBER=true (default false)
      --batch-size N         BATCH_SIZE=N (task default 100)
      --detail           Per-provider field checklist (default when you name ids)
      --summary          One line per provider instead (default with --all)
      --preflight        READ-ONLY. Cross-check provider_billing_informations
                         against the legal entity, field by field. PASS/FAIL.
      --postflight       READ-ONLY. Is every plugin pointing at its provider's
                         primary legal entity? PASS/FAIL. (--verify is an alias.)
      --apply            DRY_RUN="false" — actually write
      --dry-run          DRY_RUN="true" — logs only (the default)
  -s, --service NAME     Houston service (default: ${DEFAULT_SERVICE})
      --print-only       Print the Houston command and stop; run nothing
      --json             Print only the UPDATES JSON array (stdout); prompts for
                         the data-access approval on stderr. Takes provider IDs
                         or --all; it does not prompt for those.
  -h, --help             Show this help

REQUIRES A TERMINAL. If stdin is not a TTY the script refuses to run — a piped
"yes" is not explicit approval, so cron/CI cannot drive it. No --force escape.

Four modes, asked as the first prompt:

  MIGRATE      Create the legal entities in the first place — runs
               ${MIGRATE_TASK} on ${MIGRATE_SERVICE}.
               Takes an explicit provider list only. No dry run exists for this
               task, so a read-only preview of each provider's current migration
               state is shown before the gate. Run this BEFORE link.


  PRE-FLIGHT   Is the data consistent? Cross-checks provider_billing_informations
   (default)   (${SHEDUL_DB}) against the legal entity's fields (${LE_DB})
               — name, tax/VAT, registration no., address, country. PASS/FAIL,
               exit 1 on any difference. Never reads plugins. READ-ONLY.

  POST-FLIGHT  Is everything linked? Compares each plugin's legal_entity_id
               against its provider's primary. PASS/FAIL, exit 1 on drift.
               READ-ONLY.

  LINK         Resolve, then run ${TASK}.
               The only mode that can write, and only via apply.

Workflow order: MIGRATE → PRE-FLIGHT → LINK → POST-FLIGHT.

The guided flow:
  1. WHICH MODE?      — pre-flight (default), post-flight, link, or migrate
  2. environment      — staging (${DEFAULT_NAMESPACE}), production, or any namespace
  3. APPROVE READS    — the target is shown and confirmed before ANY query runs
  4. providers        — all of them, or a list you type
  5. reads (read-only) — every statement is echoed before it runs

  PRE-FLIGHT and POST-FLIGHT stop here with a PASS/FAIL verdict.
  LINK continues:

  6. report           — what resolved, and which providers are exempt
  7. dry run or apply — asked with the report on screen
  8. APPROVE THE RUN  — non-prod: one "yes". PRODUCTION: type the namespace
                        back, THEN "yes".
  9. runs the task    — the exact command is printed before it runs
 10. reads back       — proves what actually landed. Exits 1 if anything didn't.

Providers are skipped (and listed in an "Exempt providers" table) when they have
no active primary legal entity, no account configuration, no plugin with a NULL
legal_entity_id, or more than one such plugin — the unique index means only one
plugin can hold a given legal entity, so an ambiguous provider is never
auto-resolved.`);
}

// --- helpers ---------------------------------------------------------------

// Accepts commas, whitespace and newlines; strips `#` comments so a --file can
// be annotated. Returns deduped ID strings in first-seen order.
function parseProviderIds(raw) {
  const ids = String(raw)
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join(",")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const invalid = ids.filter((s) => !/^\d+$/.test(s));
  if (invalid.length) {
    throw new Error(`Invalid provider IDs (must be positive integers): ${invalid.join(", ")}`);
  }
  if (!ids.length) throw new Error("No provider IDs provided.");
  return [...new Set(ids)];
}

// The psql database environment for a given deploy namespace. Mirrors
// retry_invoices.js: "production" is its own env, anything else is the namespace.
function psqlEnv(namespace) {
  return namespace === "production" ? "production" : namespace;
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

// --- prompting --------------------------------------------------------------
//
// ONE readline for the whole run, created lazily and closed only when we're done
// (or before spawning Houston, which needs stdin itself).
//
// Two traps this avoids, both of which silently lose answers once you ask more
// than one question in a row:
//
//   1. Opening and closing a fresh interface per question — as the older scripts
//      here do — breaks from the second prompt onwards on piped stdin: closing an
//      interface consumes the rest of the stream.
//   2. `rl.question` only captures a line if it is already awaiting one. On a
//      pipe, readline emits every buffered line as fast as it can, so lines that
//      arrive while we're busy between prompts are dropped on the floor.
//
// So we listen for `line` once and queue what arrives; `ask` takes from the queue
// when it's non-empty and waits otherwise. Nothing is lost either way.

let rl = null;
let inputClosed = false;
const bufferedLines = []; // lines that arrived before anyone asked for them
const waitingAskers = []; // resolvers parked until the next line shows up

// Where prompts are written. --json keeps stdout pure for the payload, so its
// gate has to talk on stderr instead. Set once, before the first ask().
let promptStream = output;

function ensureRl() {
  if (rl) return rl;

  rl = readline.createInterface({ input, output: promptStream });
  rl.on("line", (line) => {
    const waiter = waitingAskers.shift();
    if (waiter) waiter(line);
    else bufferedLines.push(line);
  });
  rl.on("close", () => {
    inputClosed = true;
    while (waitingAskers.length) waitingAskers.shift()(null);
  });
  return rl;
}

function closeRl() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

// Running out of input is an abort, never an implicit "accept the default" — a
// Ctrl-D (or a piped script that's one line short) must not confirm a write.
function endOfInput() {
  throw new Error("Input ended before the prompt was answered. Aborting; nothing was run.");
}

async function ask(question) {
  ensureRl();
  promptStream.write(question);

  if (bufferedLines.length) return bufferedLines.shift();
  if (inputClosed) endOfInput();

  const line = await new Promise((resolve) => waitingAskers.push(resolve));
  if (line === null) endOfInput();
  return line;
}

// Numbered menu. Accepts the number, any of the option's aliases, or blank for
// the default. Re-asks up to 3 times on nonsense.
async function askChoice(title, choices) {
  const def = choices.find((c) => c.default) || choices[0];

  console.log(`\n${title}`);
  choices.forEach((c, i) => {
    console.log(`  ${i + 1}) ${c.label}${c === def ? "   [default]" : ""}`);
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = (await ask("  > ")).trim().toLowerCase();
    if (!raw) return def.value;

    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].value;

    const match = choices.find((c) => (c.aliases || []).includes(raw));
    if (match) return match.value;

    console.error(`  Not an option. Enter 1-${choices.length}, a name, or blank for the default.`);
  }
  throw new Error("Too many invalid answers.");
}

function runInherit(cmd, args) {
  // Hand stdin back to the child — Houston has its own prompts.
  closeRl();
  console.log(`\n$ ${cmd} ${args.join(" ")}\n`);
  // Ensure the terminal is in cooked (line) mode so Houston's own interactive
  // prompts can read input.
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

function isProd(namespace) {
  return PROD_NAMESPACES.has(namespace.toLowerCase());
}

// Read-only psql. -t -A -F| gives bare pipe-delimited rows; a NULL column comes
// back as an empty field. Every statement is echoed before it runs — this script
// reads production, so what it asks for should never be a mystery.
function psqlRead(env, db, sql) {
  echoSql(`houston psql ${env} ${db}`, sql);

  return runCapture("houston", [
    "psql",
    env,
    db,
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

// Split psql output into per-row field arrays. `houston psql` prefixes its
// output with a correlation-id / timestamp preamble, so drop any line that
// doesn't have the expected field count.
function parseRows(out, fieldCount) {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => line.split("|"))
    .filter((fields) => fields.length === fieldCount);
}

// --- queries ---------------------------------------------------------------

// provider_id -> legal_entity_id for the ACTIVE primary row only. This is the
// SQL behind the get_primary_legal_entity_id_for_provider RPC. IDs are validated
// integers before they get here, so interpolation is safe.
function fetchPrimaryLegalEntities(env, providerIds) {
  const sql =
    "SELECT provider_id, legal_entity_id\n" +
    "FROM provider_purchases_primary_legal_entities\n" +
    `WHERE provider_id IN (${providerIds.join(",")})\n` +
    "  AND valid_to IS NULL;";

  const map = new Map();
  for (const [providerId, legalEntityId] of parseRows(psqlRead(env, SHEDUL_DB, sql), 2)) {
    if (legalEntityId) map.set(providerId, legalEntityId);
  }
  return map;
}

// Every provider that has an account configuration at all — the default target
// set when you don't name providers yourself. DISTINCT because a provider can
// have more than one configuration; NULL provider_id rows (migrated configs that
// only link through invoice_entity_id) can't be resolved here, so they're excluded.
function fetchAllProviderIds(env) {
  const sql =
    "SELECT DISTINCT provider_id\n" +
    "FROM account_configurations\n" +
    "WHERE provider_id IS NOT NULL\n" +
    "ORDER BY provider_id;";

  return parseRows(psqlRead(env, AD_DB, sql), 1)
    .map(([providerId]) => providerId)
    .filter((id) => /^\d+$/.test(id));
}

// Read `legal_entity_id` straight back out of the DB for the plugins we just
// touched. This is the verification pass: the task's exit code only says the job
// ran, not that any particular row changed — the action logs and skips
// individually. Returns pluginId -> legalEntityId, with absent keys meaning the
// plugin row itself is gone.
function fetchAppliedLegalEntities(env, pluginIds) {
  const sql =
    "SELECT p.id, coalesce(p.legal_entity_id::text, '')\n" +
    "FROM account_configuration_plugins p\n" +
    `WHERE p.id IN (${pluginIds.join(",")})\n` +
    "ORDER BY p.id;";

  const map = new Map();
  for (const [id, legalEntityId] of parseRows(psqlRead(env, AD_DB, sql), 2)) {
    map.set(id, legalEntityId || null);
  }
  return map;
}

// provider_id -> [{ id, pluginType, integrator, pluginStatus, legalEntityId }]
function fetchPlugins(env, providerIds) {
  const sql =
    "SELECT ac.provider_id, p.id, p.plugin_type, p.integrator, p.plugin_status,\n" +
    "       coalesce(p.legal_entity_id::text, '')\n" +
    "FROM account_configuration_plugins p\n" +
    "JOIN account_configurations ac ON ac.id = p.account_configuration_id\n" +
    `WHERE ac.provider_id IN (${providerIds.join(",")})\n` +
    "ORDER BY ac.provider_id, p.id;";

  const map = new Map();
  for (const fields of parseRows(psqlRead(env, AD_DB, sql), 6)) {
    const [providerId, id, pluginType, integrator, pluginStatus, legalEntityId] = fields;
    if (!map.has(providerId)) map.set(providerId, []);
    map.get(providerId).push({
      id,
      pluginType,
      integrator,
      pluginStatus,
      legalEntityId: legalEntityId || null,
    });
  }
  return map;
}

// --- resolution ------------------------------------------------------------

// Decide, per provider, which plugin (if any) should receive the primary legal
// entity. Returns { updates, skipped } where updates entries are exactly the
// shape the task expects: { plugin_id, legal_entity_id }.
function resolve(providerIds, primaryByProvider, pluginsByProvider) {
  const updates = [];
  const skipped = [];

  for (const providerId of providerIds) {
    const legalEntityId = primaryByProvider.get(providerId);
    const plugins = pluginsByProvider.get(providerId) || [];

    // Reasons are kept short — they're rendered as a table column. The full
    // explanation of each lives in this directory's AGENTS.md.
    if (!legalEntityId) {
      skipped.push({
        providerId,
        reason: "no active primary legal entity (RPC would answer NOT_FOUND)",
        plugins,
      });
      continue;
    }

    if (!plugins.length) {
      skipped.push({
        providerId,
        reason: "no plugins — provider has no e-invoicing config yet",
        plugins,
      });
      continue;
    }

    const alreadySet = plugins.filter((p) => p.legalEntityId);
    const candidates = plugins.filter((p) => !p.legalEntityId);

    if (!candidates.length) {
      const matching = alreadySet.some((p) => p.legalEntityId === legalEntityId);
      skipped.push({
        providerId,
        reason: matching
          ? "already linked to this legal entity"
          : "all plugins already have a legal_entity_id (never overwritten)",
        plugins,
      });
      continue;
    }

    if (candidates.length > 1) {
      skipped.push({
        providerId,
        reason: `${candidates.length} unlinked plugins — ambiguous, pick one by hand`,
        plugins,
      });
      continue;
    }

    updates.push({
      plugin_id: Number(candidates[0].id),
      legal_entity_id: legalEntityId,
      _providerId: providerId,
      _plugin: candidates[0],
    });
  }

  return { updates, skipped };
}

// Two providers sharing one legal entity would collide on the unique index — the
// task skips the loser, so surface it here rather than letting it surprise you.
function findLegalEntityCollisions(updates) {
  const byLegalEntity = new Map();
  for (const u of updates) {
    if (!byLegalEntity.has(u.legal_entity_id)) byLegalEntity.set(u.legal_entity_id, []);
    byLegalEntity.get(u.legal_entity_id).push(u);
  }
  return [...byLegalEntity.entries()].filter(([, us]) => us.length > 1);
}

// --- output ----------------------------------------------------------------

function fmtPlugin(p) {
  return (
    `plugin=${p.id} type=${p.pluginType} integrator=${p.integrator} ` +
    `status=${p.pluginStatus} legal_entity=${p.legalEntityId ?? "∅"}`
  );
}

// The UPDATES value, stripped of the internal _-prefixed bookkeeping fields.
function updatesJson(updates) {
  return JSON.stringify(
    updates.map(({ plugin_id, legal_entity_id }) => ({ plugin_id, legal_entity_id }))
  );
}

// The argv actually handed to `houston`. No shell involved, so the JSON needs no
// quoting here — buildCommand adds the quotes only for the printed form.
function taskArgs(opts, updates) {
  return [
    "task",
    "run",
    opts.service,
    "--namespace",
    opts.namespace,
    TASK,
    "-p",
    `UPDATES=${updatesJson(updates)}`,
    "-p",
    `DRY_RUN=${opts.apply ? "false" : "true"}`,
  ];
}

// The paste-able form. UPDATES is single-quoted for the shell: the JSON contains
// double quotes, and a validated UUID / integer payload can never contain a
// single quote to break out with.
function buildCommand(opts, updates) {
  return (
    `houston task run ${opts.service} --namespace ${opts.namespace} \\\n` +
    `    ${TASK} \\\n` +
    `    -p UPDATES='${updatesJson(updates)}' \\\n` +
    `    -p DRY_RUN="${opts.apply ? "false" : "true"}"`
  );
}

// --- field comparison (PBI ↔ legal entity) -----------------------------------

// Like parseRows, but tolerant of the delimiter appearing inside the LAST field
// — a street or a legal name can legitimately contain a "|". Everything past the
// (n-1)th delimiter is rejoined into the final column.
function parseRowsLoose(out, fieldCount) {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|");
      if (parts.length < fieldCount) return null;
      if (parts.length === fieldCount) return parts;
      return [...parts.slice(0, fieldCount - 1), parts.slice(fieldCount - 1).join("|")];
    })
    .filter(Boolean);
}

// The ACTIVE billing information row per provider. Same valid_to convention as
// provider_purchases_primary_legal_entities: NULL means current, non-NULL is a
// superseded history row.
function fetchBillingInformations(env, providerIds) {
  const sql =
    `SELECT ${PBI_COLUMNS.map((col) => `coalesce(${col}::text, '')`).join(", ")}\n` +
    "FROM provider_billing_informations\n" +
    `WHERE provider_id IN (${providerIds.join(",")})\n` +
    "  AND valid_to IS NULL\n" +
    "ORDER BY provider_id;";

  const map = new Map();
  for (const fields of parseRowsLoose(psqlRead(env, SHEDUL_DB, sql), PBI_COLUMNS.length)) {
    const row = Object.fromEntries(PBI_COLUMNS.map((col, i) => [col, fields[i]]));
    map.set(row.provider_id, row);
  }
  return map;
}

// legalEntityId -> Map(fieldKey -> value). `fields` is a jsonb array of
// {key, value}, so it's unnested into one row per field; the country_code column
// is unioned in as a pseudo-key so the comparison can fall back to it.
function fetchLegalEntityFields(env, legalEntityIds) {
  if (!legalEntityIds.length) return new Map();
  const quoted = legalEntityIds.map((id) => `'${id}'`).join(",");

  const sql =
    "SELECT le.id::text, f->>'key', coalesce(f->>'value', '')\n" +
    "FROM legal_entities le, jsonb_array_elements(le.fields) f\n" +
    `WHERE le.id IN (${quoted})\n` +
    "UNION ALL\n" +
    "SELECT le.id::text, '_column.country_code', coalesce(le.country_code, '')\n" +
    "FROM legal_entities le\n" +
    `WHERE le.id IN (${quoted})\n` +
    "UNION ALL\n" +
    "SELECT le.id::text, '_column.type', coalesce(le.type::text, '')\n" +
    "FROM legal_entities le\n" +
    `WHERE le.id IN (${quoted});`;

  const map = new Map();
  for (const [id, key, value] of parseRowsLoose(psqlRead(env, LE_DB, sql), 3)) {
    if (!map.has(id)) map.set(id, new Map());
    map.get(id).set(key, value);
  }
  return map;
}

// When nothing matched there is still a key worth naming — the one this entity
// *would* use. Picking spec.le[0] blindly would show an organization key against
// an individual entity, which reads as a wrong lookup rather than a missing value.
function fallbackLeKey(keys, kind) {
  if (!keys.length) return "";
  const individual = (k) => k.startsWith("individual.");
  const wanted = keys.filter((k) => (kind === "individual" ? individual(k) : !individual(k)));
  return (wanted[0] || keys[0]);
}

// Compare on meaning, not bytes: trim, collapse runs of whitespace, casefold.
// Otherwise "Via Giovanni Giolitti 40" vs "via giovanni giolitti  40" reads as a
// difference when it plainly isn't one.
function normalizeValue(v) {
  return String(v || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// First non-empty value among the candidate keys, and which key supplied it —
// the key matters for the per-provider checklist, where showing
// `organization.vatNumber` vs `organization.taxInformation.number` is the point.
function leValue(fields, keys) {
  if (!fields) return { value: "", key: "" };
  for (const key of keys) {
    const v = fields.get(key);
    if (v) return { value: v, key };
  }
  return { value: "", key: "" };
}

// Per provider: which comparable fields agree, and which don't. A field where
// both sides are empty isn't comparable and is skipped entirely.
function compareFields(providerId, billing, fields) {
  const rows = [];
  // "individual" vs everything else (organization, trust, sole_proprietorship,
  // unincorporated_partnership) — see `only` on FIELD_COMPARISON.
  const entityType = (fields && fields.get("_column.type")) || "";
  const kind = entityType === "individual" ? "individual" : "organization";

  for (const spec of FIELD_COMPARISON) {
    if (spec.only && spec.only !== kind) continue;

    const pbiValue = billing ? billing[spec.pbi] || "" : "";
    const { value: leVal, key: leKey } = leValue(fields, spec.le);
    if (!pbiValue && !leVal) continue;

    const same = normalizeValue(pbiValue) === normalizeValue(leVal);
    // "present?" in the per-provider checklist.
    const presence = pbiValue && leVal ? "both" : pbiValue ? "provider only" : "legal entity only";

    rows.push({
      label: spec.label,
      pbi: pbiValue,
      le: leVal,
      leKey: leKey || fallbackLeKey(spec.le, kind),
      // No legal-entity counterpart exists for this column, so "provider only"
      // is correct by design — reported, never counted against the verdict.
      informational: Boolean(spec.informational),
      same,
      presence,
      note: same ? "" : !pbiValue ? "missing in billing info" : !leVal ? "missing in legal entity" : "differs",
    });
  }

  return {
    providerId,
    billing,
    entityType,
    rows,
    diffs: rows.filter((r) => !r.same && !r.informational),
  };
}

// The per-provider checklist: every comparable field, matching or not, with the
// legal-entity key that supplied the value. This is the "are these good?" view —
// printFieldComparison's tables only surface what disagrees.
function printProviderFieldTable(cmp) {
  const mark = (row) => {
    if (row.informational) return `${c.faint("provider only")}`;
    if (row.same) return `${c.ok("✅")} both`;
    if (row.presence === "both") return `${c.bad("❌")} differs`;
    return `${c.warn("⚠")} ${row.presence}`;
  };

  console.log(
    c.head(
      `\n── provider=${cmp.providerId} (${cmp.entityType || "unknown type"}) ` +
        "─────────────────────────"
    )
  );

  console.log(
    renderTable(
      ["REQUIRED FIELD", `PROVIDER BILLING (${SHEDUL_DB})`, `LEGAL ENTITY (fields jsonb)`, "PRESENT?"],
      cmp.rows.map((r) => [
        r.label,
        r.pbi || "—",
        r.le ? `${c.sql(r.leKey)} = ${r.le}` : r.leKey ? c.faint(`${r.leKey} = ∅`) : "—",
        mark(r),
      ])
    )
  );

  const comparable = cmp.rows.filter((r) => !r.informational);
  const matched = comparable.filter((r) => r.same).length;
  console.log(
    `\n  ${matched === comparable.length ? c.ok("✓") : c.bad("✗")} ` +
      `${matched}/${comparable.length} comparable fields agree` +
      c.faint(
        `   (${cmp.rows.length - comparable.length} provider-only column(s) shown for ` +
          "completeness, not compared)"
      )
  );
}

function printFieldComparison(comparisons) {
  console.log(
    c.head("\n── Field comparison (provider_billing_informations ↔ legal entity) ──")
  );

  const noBilling = comparisons.filter((cmp) => !cmp.billing);
  const withDiffs = comparisons.filter((cmp) => cmp.billing && cmp.diffs.length);
  const clean = comparisons.filter((cmp) => cmp.billing && !cmp.diffs.length);

  for (const cmp of clean) {
    console.log(
      `  ${c.ok("✓")} provider=${cmp.providerId}  ` +
        c.faint(`${cmp.rows.length}/${cmp.rows.length} comparable fields match`)
    );
  }

  for (const cmp of noBilling) {
    console.log(
      `  ${c.faint("–")} provider=${cmp.providerId}  ` +
        c.faint("no active provider_billing_informations row — nothing to compare")
    );
  }

  // Only the providers that actually differ get a table; the rest would be noise.
  for (const cmp of withDiffs) {
    const matched = cmp.rows.length - cmp.diffs.length;
    console.log(
      `\n  ${c.bad("✗")} provider=${cmp.providerId}  ` +
        `${matched}/${cmp.rows.length} match — ${cmp.diffs.length} differ:`
    );
    console.log(
      renderTable(
        ["FIELD", "PROVIDER BILLING INFO", "LEGAL ENTITY", "NOTE"],
        cmp.diffs.map((d) => [d.label, d.pbi || "∅", d.le || "∅", c.warn(d.note)])
      )
        .split("\n")
        .map((l) => `      ${l}`)
        .join("\n")
    );
  }

  console.log(
    `\n  ${c.ok(`✓ ${clean.length} consistent`)}   ` +
      `${c.faint(`– ${noBilling.length} no billing row`)}   ` +
      `${withDiffs.length ? c.bad(`✗ ${withDiffs.length} differ`) : `✗ 0 differ`}`
  );

  return { clean: clean.length, noBilling: noBilling.length, differ: withDiffs.length };
}

// The pre-flight verdict. A field difference is a FAIL: the whole point of a
// pre-flight is to say whether the data is fit to proceed on, and two systems
// disagreeing about a legal name or a tax number is precisely what you want to
// know before linking anything.
//
// Missing rows are warnings, not failures — a provider with no billing info or
// no primary legal entity has nothing to be inconsistent about. Those are gaps
// to notice, not contradictions.
function printPreflightVerdict(tally, missingLegalEntity) {
  const failed = tally.differ > 0;
  const warnings = tally.noBilling + missingLegalEntity;

  console.log(
    failed
      ? c.bad("\n══ PRE-FLIGHT: FAIL ════════════════════════════════════")
      : c.ok("\n══ PRE-FLIGHT: PASS ════════════════════════════════════")
  );

  if (failed) {
    console.log(
      `  ${c.bad("✗")} ${tally.differ} provider(s) where billing info and the legal entity disagree.`
    );
    console.log(c.faint("    Reconcile those before linking — see the tables above."));
  } else {
    console.log(
      `  ${c.ok("✓")} ${tally.clean} provider(s) checked, every comparable field agrees.`
    );
  }

  if (warnings) {
    console.log(
      `  ${c.warn("⚠")} ${warnings} skipped: ` +
        `${tally.noBilling} with no billing row, ` +
        `${missingLegalEntity} with no primary legal entity.` +
        c.faint("  (Nothing to compare — not counted as a failure.)")
    );
  }

  console.log(c.faint("\n  Read-only: this mode issues SELECTs and nothing else."));
  return failed;
}

// --- migrate -----------------------------------------------------------------
//
// Drives `legal_entities_migration:migrate` on partners-app (app-shedul), the
// step that CREATES each provider's legal entity and sets it primary. Everything
// the other modes inspect depends on this having run.
//
// The task has no DRY_RUN — it writes on first call. So the stand-in is a
// read-only preview of where each provider currently stands, shown before the
// confirmation gate. It is resumable though: ensure_legal_entity_created returns
// early when the status is already `migrated`, find_or_create_status reuses an
// existing row, and the blast-marketing update only claims rows whose
// legal_entity_id IS NULL — so a re-run resumes rather than duplicating.

// One row per (provider, migration_type). A provider can hold several status rows
// — one per type — so the LEFT JOIN legitimately fans out; every row is shown.
// Providers absent from `providers` come back with no row at all and are flagged.
function fetchMigrationStatuses(env, providerIds) {
  const sql =
    "SELECT p.id::text, coalesce(p.country_code, ''), coalesce(p.fresha_pay::text, ''),\n" +
    "       coalesce(s.migration_type, ''), coalesce(s.status, ''),\n" +
    "       coalesce(s.legal_entity_id::text, ''),\n" +
    "       coalesce(s.payment_method_migrated::text, '')\n" +
    "FROM providers p\n" +
    "LEFT JOIN billing_migration_statuses s ON s.provider_id = p.id\n" +
    `WHERE p.id IN (${providerIds.join(",")})\n` +
    "ORDER BY p.id, s.migration_type;";

  const byProvider = new Map();
  for (const row of parseRowsLoose(psqlRead(env, SHEDUL_DB, sql), 7)) {
    const [id, countryCode, freshaPay, migrationType, status, legalEntityId, pmMigrated] = row;
    if (!byProvider.has(id)) {
      byProvider.set(id, { providerId: id, countryCode, freshaPay, statuses: [] });
    }
    if (migrationType || status) {
      byProvider.get(id).statuses.push({
        migrationType,
        status,
        legalEntityId,
        paymentMethodMigrated: pmMigrated === "t" || pmMigrated === "true",
      });
    }
  }
  return byProvider;
}

// What running the task would mean for a provider in this state.
function migrateVerdict(entry) {
  if (!entry) return { text: "⚠ provider not found in providers", bad: true };
  if (!entry.statuses.length) return { text: "new — will migrate", bad: false };

  const statuses = entry.statuses.map((s) => s.status);
  if (statuses.includes("failed")) return { text: "previously failed — will retry", bad: true };
  if (statuses.every((s) => s === "confirmed")) {
    return { text: "already confirmed — re-run resumes, no duplicate", bad: false };
  }
  if (statuses.includes("migrated")) {
    return { text: "partially migrated — will resume", bad: false };
  }
  if (statuses.includes("pending")) return { text: "pending — will retry", bad: false };
  return { text: statuses.join(","), bad: false };
}

function printMigratePreview(providerIds, byProvider) {
  console.log(c.head("\n── Current migration state (read-only) ─────────────────"));

  const rows = [];
  for (const id of providerIds) {
    const entry = byProvider.get(id);
    const verdict = migrateVerdict(entry);

    if (!entry || !entry.statuses.length) {
      rows.push([
        id,
        entry ? entry.countryCode : "—",
        entry ? entry.freshaPay || "∅" : "—",
        "—",
        "—",
        "—",
        verdict.bad ? c.bad(verdict.text) : verdict.text,
      ]);
      continue;
    }

    entry.statuses.forEach((s, i) => {
      rows.push([
        i === 0 ? id : "",
        i === 0 ? entry.countryCode : "",
        i === 0 ? entry.freshaPay || "∅" : "",
        s.migrationType,
        s.status,
        s.legalEntityId || "∅",
        i === 0 ? (verdict.bad ? c.bad(verdict.text) : verdict.text) : "",
      ]);
    });
  }

  console.log(
    renderTable(
      ["PROVIDER", "CC", "FRESHA_PAY", "MIGRATION TYPE", "STATUS", "LEGAL ENTITY", "WHAT WILL HAPPEN"],
      rows
    )
  );

  const missing = providerIds.filter((id) => !byProvider.has(id));
  if (missing.length) {
    console.log(c.bad(`\n  ⚠ Not found in providers: ${missing.join(", ")}`));
  }

  console.log(
    c.faint(
      "\n  MIGRATION TYPE / STATUS are what is already recorded. For a provider with\n" +
        "  no row yet, the branch is decided server-side by resolve_migration_type\n" +
        "  (plus the fresha_pay nil/not_set → billing_only special case), so CC and\n" +
        "  FRESHA_PAY are shown as the inputs rather than a guessed outcome."
    )
  );

  return missing.length;
}

function migrateTaskArgs(opts, providerIds) {
  const args = [
    "task",
    "run",
    MIGRATE_SERVICE,
    "--namespace",
    opts.namespace,
    MIGRATE_TASK,
    "-p",
    `PROVIDER_IDS=${providerIds.join(",")}`,
    "-p",
    `MIGRATE_PAYMENT_METHODS=${opts.migratePaymentMethods}`,
  ];
  if (opts.copyTaxNumber) args.push("-p", "COPY_TAX_NUMBER=true");
  if (opts.batchSize) args.push("-p", `BATCH_SIZE=${opts.batchSize}`);
  return args;
}

function buildMigrateCommand(opts, providerIds) {
  const lines = [
    `houston task run ${MIGRATE_SERVICE} --namespace ${opts.namespace} \\`,
    `    ${MIGRATE_TASK} \\`,
    `    -p PROVIDER_IDS=${providerIds.join(",")} \\`,
    `    -p MIGRATE_PAYMENT_METHODS="${opts.migratePaymentMethods}"`,
  ];
  if (opts.copyTaxNumber) {
    lines[lines.length - 1] += " \\";
    lines.push(`    -p COPY_TAX_NUMBER="true"`);
  }
  if (opts.batchSize) {
    lines[lines.length - 1] += " \\";
    lines.push(`    -p BATCH_SIZE="${opts.batchSize}"`);
  }
  return lines.join("\n");
}

// Migrate has no dry run, so the gate has to carry that weight explicitly.
function printMigrateWarning(opts) {
  console.log(
    c.warn(
      "\n  ⚠ This task has NO dry run — it writes on the first call. It creates each\n" +
        "    provider's legal entity and sets it as primary."
    )
  );
  if (opts.migratePaymentMethods) {
    console.log(
      c.warn(
        "    MIGRATE_PAYMENT_METHODS=true also migrates cards on file through an RPC\n" +
          "    — an external side effect. Pass --no-payment-methods to skip that."
      )
    );
  }
  console.log(
    c.faint(
      "    It is resumable: an already-migrated provider is resumed, not duplicated."
    )
  );
}

// Before → after, per provider. The task logs per-provider outcomes and still
// exits 0 on failures, so as with the link mode the read-back is the evidence.
function printMigrateReadback(providerIds, before, after) {
  console.log(c.head("\n── Verification ────────────────────────────────────────"));

  const rows = [];
  let failures = 0;

  for (const id of providerIds) {
    const was = migrateVerdict(before.get(id)).text;
    const entry = after.get(id);
    const statuses = entry ? entry.statuses.map((s) => s.status) : [];
    const now = statuses.length ? statuses.join(",") : "—";

    const ok = statuses.length > 0 && !statuses.includes("failed");
    if (!ok) failures++;

    rows.push([
      ok ? c.ok("✓") : c.bad("✗"),
      id,
      was,
      now,
      entry && entry.statuses.find((s) => s.legalEntityId)
        ? entry.statuses.find((s) => s.legalEntityId).legalEntityId
        : "∅",
      ok ? "migrated" : statuses.includes("failed") ? "FAILED — see task logs" : "no status row written",
    ]);
  }

  console.log(
    renderTable(["", "PROVIDER", "BEFORE", "AFTER", "LEGAL ENTITY", "RESULT"], rows)
  );
  console.log(
    c.faint(
      `\n  Method: re-read providers + billing_migration_statuses from ${SHEDUL_DB} after\n` +
        "  the task. The task exits 0 even when individual providers fail, so its exit\n" +
        "  code alone proves nothing — only the read-back does."
    )
  );

  console.log(
    failures
      ? c.bad(`\n══ MIGRATE: FAIL ═══════════════════════════════════════`)
      : c.ok(`\n══ MIGRATE: PASS ═══════════════════════════════════════`)
  );
  console.log(
    failures
      ? `  ${c.bad("✗")} ${failures} of ${providerIds.length} did not migrate. See RESULT above.`
      : `  ${c.ok("✓")} all ${providerIds.length} provider(s) migrated.`
  );
  if (!failures) {
    console.log(
      c.faint("\n  Next: pre-flight to check the data, then link to connect the plugins.")
    );
  }

  return failures;
}

// --- audit (--verify) --------------------------------------------------------
//
// Standalone verification: for every requested provider, compare what its plugin
// actually holds against the primary legal entity that owns it. Runs nothing and
// writes nothing — it answers "is this namespace correctly linked right now?"
//
// Needs no extra queries: the plugin read already returns legal_entity_id, so
// this is pure comparison over data we've already fetched.

// One row per provider. `state` drives both the symbol and the exit code:
// "ok" and "exempt" pass, "drift" fails.
function auditProviders(providerIds, primaryByProvider, pluginsByProvider) {
  return providerIds.map((providerId) => {
    const expected = primaryByProvider.get(providerId) || null;
    const plugins = pluginsByProvider.get(providerId) || [];
    const row = { providerId, expected, plugins };

    if (!expected) {
      return { ...row, state: "exempt", status: "no primary legal entity — nothing to link" };
    }
    if (!plugins.length) {
      return { ...row, state: "exempt", status: "no plugins — no e-invoicing config" };
    }

    const holder = plugins.find((p) => p.legalEntityId === expected);
    if (holder) {
      return { ...row, state: "ok", plugin: holder, status: "linked correctly" };
    }

    // Nothing holds the expected value. Distinguish "never linked" from "linked
    // to the wrong thing" — the first is pending work, the second is real drift.
    const wrong = plugins.filter((p) => p.legalEntityId);
    const unlinked = plugins.filter((p) => !p.legalEntityId);

    if (wrong.length) {
      return {
        ...row,
        state: "drift",
        plugin: wrong[0],
        status: "MISMATCH — holds a different legal entity",
      };
    }
    if (unlinked.length > 1) {
      return { ...row, state: "drift", status: `not linked — ${unlinked.length} candidates` };
    }
    return { ...row, state: "drift", plugin: unlinked[0], status: "not linked" };
  });
}

const AUDIT_SYMBOL = { ok: c.ok("✓"), exempt: c.faint("–"), drift: c.bad("✗") };

function printAudit(opts, audit) {
  const short = (uuid) => uuid || "∅";

  console.log(c.head("\n── Verification ────────────────────────────────────────"));
  console.log(
    renderTable(
      ["", "PROVIDER", "PLUGIN", "EXPECTED (primary LE)", "ACTUAL (plugin LE)", "STATUS"],
      audit.map((a) => [
        AUDIT_SYMBOL[a.state],
        a.providerId,
        a.plugin ? a.plugin.id : "—",
        short(a.expected),
        a.plugin ? short(a.plugin.legalEntityId) : "—",
        a.status,
      ])
    )
  );

  const ok = audit.filter((a) => a.state === "ok");
  const exempt = audit.filter((a) => a.state === "exempt");
  const drift = audit.filter((a) => a.state === "drift");

  console.log(
    `\n  Method: compared account_configuration_plugins.legal_entity_id (${AD_DB}) ` +
      `against the active row in\n  provider_purchases_primary_legal_entities ` +
      `(${SHEDUL_DB}) for each provider. Both reads, no writes.`
  );
  console.log(
    `\n  ✓ ${ok.length} linked correctly   ` +
      `– ${exempt.length} exempt   ` +
      `✗ ${drift.length} need attention`
  );

  if (drift.length) {
    const mismatches = drift.filter((a) => a.status.startsWith("MISMATCH"));
    if (mismatches.length) {
      console.log(
        c.warn(
          `\n  ⚠  ${mismatches.length} MISMATCH(es) — a plugin holds a legal entity that is not\n` +
            `     its provider's primary. This script will NOT fix those: the task only\n` +
            `     fills NULLs and never overwrites. Investigate before changing anything.`
        )
      );
    }
    const fixable = drift.filter((a) => a.status === "not linked");
    if (fixable.length) {
      console.log(
        `\n  ${fixable.length} provider(s) simply not linked yet. To link them, re-run without\n` +
          `  --verify and choose apply:  ${fixable.map((a) => a.providerId).join(",")}`
      );
    }
  }

  return drift.length;
}

// --- verification -----------------------------------------------------------

// Compare what we intended against what the DB actually holds now. `applied` is
// the read-back map. Under a dry run the expectation is inverted: the row must
// still be NULL, and anything else means the task wrote when it shouldn't have.
function verdictFor(update, applied, dryRun) {
  const pluginId = String(update.plugin_id);
  const intended = update.legal_entity_id;

  if (!applied.has(pluginId)) {
    return { ok: false, note: "plugin row not found on read-back" };
  }

  const actual = applied.get(pluginId);

  if (dryRun) {
    return actual === null
      ? { ok: true, note: "unchanged, still NULL — correct for a dry run" }
      : { ok: false, note: `dry run but row is set to ${actual}` };
  }

  if (actual === intended) return { ok: true, note: "matches intended legal_entity_id" };
  if (actual === null) {
    return { ok: false, note: "still NULL — task skipped it (likely a unique-index collision)" };
  }
  return { ok: false, note: `holds a different legal entity: ${actual}` };
}

// Fixed-width table. Kept deliberately plain so it survives copy-paste into a
// ticket or a Slack snippet.
function renderTable(headers, rows) {
  // Measure what the eye sees, not what the string holds: a coloured cell
  // carries escape bytes that padEnd would otherwise count as width.
  const visible = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
  const width = (s) => visible(s).length;
  const pad = (s, w) => String(s) + " ".repeat(Math.max(0, w - width(s)));

  const widths = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]))));
  const line = (cells) => cells.map((cell, i) => pad(cell, widths[i])).join("  ").trimEnd();

  return [line(headers), widths.map((w) => "─".repeat(w)).join("  "), ...rows.map(line)].join(
    "\n"
  );
}

// The post-run report: one row per plugin we tried to link, what it now holds,
// and how that was established.
function printVerification(opts, updates, applied) {
  const dryRun = !opts.apply;

  const rows = updates.map((u) => {
    const v = verdictFor(u, applied, dryRun);
    return [
      u.plugin_id,
      u._providerId,
      u.legal_entity_id,
      `${v.ok ? "✓" : "✗"} read-back`,
      v.note,
    ];
  });

  const failures = rows.filter((r) => r[3].startsWith("✗")).length;

  console.log(c.head("\n── Verification ────────────────────────────────────────"));
  console.log(
    renderTable(
      ["PLUGIN", "PROVIDER", "LEGAL ENTITY APPLIED", "VERIFIED BY", "RESULT"],
      rows
    )
  );

  console.log(
    `\n  Method: re-read account_configuration_plugins.legal_entity_id from ` +
      `${AD_DB} (${opts.namespace}) after the task, and compared each row to the\n` +
      `  value this script intended. The task's exit code alone proves nothing — ` +
      `the action skips rows individually and still exits 0.`
  );

  console.log(
    failures
      ? c.bad(`\n  ⚠  ${failures} of ${rows.length} did NOT verify. See RESULT above.`)
      : c.ok(`\n  ✓ All ${rows.length} verified.`)
  );

  printCrossCheck(opts, updates);
  return failures;
}

// The user-runnable equivalent, so the table above can be independently
// confirmed without trusting this script at all.
function printCrossCheck(opts, updates) {
  const pluginIds = updates.map((u) => u.plugin_id).join(",");
  const providerIds = [...new Set(updates.map((u) => u._providerId))].join(",");

  const env = psqlEnv(opts.namespace);

  // Same colour split as everywhere else: yellow for the command you'd type,
  // cyan for the SQL inside it.
  const block = (comment, db, lines) =>
    `    ${c.faint(comment)}\n` +
    `    ${c.cmd(`houston psql ${env} ${db} -- -c "`)}\n` +
    lines.map((l) => `      ${c.sql(l)}`).join("\n") +
    `${c.cmd('"')}\n`;

  console.log(c.head("\n  Cross-check it yourself:"));
  console.log(
    "\n" +
      block("# what the plugins now hold", AD_DB, [
        "SELECT ac.provider_id, p.id AS plugin_id, p.legal_entity_id, p.updated_at",
        "FROM account_configuration_plugins p",
        "JOIN account_configurations ac ON ac.id = p.account_configuration_id",
        `WHERE p.id IN (${pluginIds})`,
        "ORDER BY ac.provider_id",
      ])
  );
  console.log(
    block("# what they SHOULD hold, straight from the source of truth", SHEDUL_DB, [
      "SELECT provider_id, legal_entity_id",
      "FROM provider_purchases_primary_legal_entities",
      `WHERE provider_id IN (${providerIds})`,
      "  AND valid_to IS NULL",
      "ORDER BY provider_id",
    ])
  );
  console.log(
    `    The two provider_id → legal_entity_id sets must be identical.\n` +
      `    Re-running this script in verify mode is the other check.`
  );
}

// Providers we deliberately did not touch, and why. Printed as a roster so the
// exempt set is explicit rather than something you infer from what's missing.
function printExemptProviders(skipped) {
  if (!skipped.length) {
    console.log(c.head("\n── Exempt providers ────────────────────────────────────"));
    console.log("  None — every requested provider resolved.");
    return;
  }

  const rows = skipped.map((s) => [
    s.providerId,
    s.plugins.length,
    s.plugins.map((p) => p.id).join(",") || "—",
    s.reason,
  ]);

  console.log(c.head("\n── Exempt providers (not touched) ──────────────────────"));
  console.log(renderTable(["PROVIDER", "PLUGINS", "PLUGIN IDS", "WHY EXEMPT"], rows));
  console.log(`\n  ${skipped.length} provider(s) exempt. Nothing was written for these.`);
}

// --- interactive steps ------------------------------------------------------

// What are we here to do? Asked first, because it decides the whole flow.
// Verify is the default: it's the one that can't change anything.
async function askMode() {
  return askChoice("What do you want to do?", [
    {
      label: "Pre-flight  — is the data consistent? (read-only, pass/fail)",
      aliases: ["pre", "preflight", "pre-flight", "check", "data"],
      value: "preflight",
      default: true,
    },
    {
      label: "Post-flight — is everything linked? (read-only, pass/fail)",
      aliases: ["post", "postflight", "post-flight", "verify", "audit"],
      value: "postflight",
    },
    {
      label: "Link        — link plugins to their primary legal entity",
      aliases: ["link", "apply", "run", "fix"],
      value: "link",
    },
    {
      label: "Migrate     — create legal entities for providers (run BEFORE link)",
      aliases: ["migrate", "migration", "create"],
      value: "migrate",
    },
  ]);
}

// Migrate takes an explicit list and nothing else. Deliberately no "all" option:
// "every provider with an account configuration" is the wrong set for a
// migration, and a stray Enter must not migrate everything.
async function askMigrateProviderIds() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await ask("\nProvider IDs to migrate (comma- or space-separated): ");
    try {
      return parseProviderIds(raw);
    } catch (err) {
      console.error(`  ${err.message}`);
    }
  }
  throw new Error("No valid provider IDs given.");
}

// Which environment. Returns a namespace string. "Other" lets you name any
// namespace without having to remember the -n flag.
async function askNamespace() {
  const choice = await askChoice("Which environment?", [
    {
      label: `staging (${DEFAULT_NAMESPACE})`,
      aliases: ["staging", "stage", DEFAULT_NAMESPACE],
      value: DEFAULT_NAMESPACE,
      default: true,
    },
    { label: "production", aliases: ["production", "prod"], value: "production" },
    { label: "other namespace…", aliases: ["other"], value: null },
  ]);

  if (choice) return choice;

  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = (await ask("  namespace> ")).trim();
    if (raw) return raw;
    console.error("  Namespace can't be blank.");
  }
  throw new Error("No namespace given.");
}

// Dry run or real write. Asked after the resolution report, so you decide with
// the actual plugin list in front of you.
async function askApply(namespace) {
  return askChoice(`Run against ${namespace} as:`, [
    {
      label: 'dry run — DRY_RUN="true", logs only, writes nothing',
      aliases: ["dry", "dry-run", "dryrun", "false"],
      value: false,
      default: true,
    },
    {
      label: 'APPLY — DRY_RUN="false", actually writes legal_entity_id',
      aliases: ["apply", "write", "real", "true"],
      value: true,
    },
  ]);
}

// Which providers to work on: everything with an account configuration, or a
// list you type. Returns validated ID strings.
async function askProviderIds(env) {
  const all = await askChoice("Which providers?", [
    {
      label: `every provider with an account configuration (${AD_DB})`,
      aliases: ["all", "every"],
      value: true,
      default: true,
    },
    { label: "a list I'll type", aliases: ["list", "some", "specific"], value: false },
  ]);

  if (all) {
    console.log(c.faint(`\nFinding providers in ${AD_DB}.account_configurations (read-only)…`));
    const ids = fetchAllProviderIds(env);
    if (!ids.length) throw new Error("No providers found in account_configurations.");
    console.log(`Found ${ids.length} provider(s) with an account configuration.`);
    return ids;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await ask("  provider IDs (comma- or space-separated): ");
    try {
      return parseProviderIds(raw);
    } catch (err) {
      console.error(`  ${err.message}`);
    }
  }
  throw new Error("No valid provider IDs given.");
}

// Approval must come from a human at a keyboard. Piped stdin is refused outright
// rather than allowed to answer the gates: a "yes" arriving down a pipe is an
// automated approval, which is exactly what these gates exist to prevent. This
// also rules out cron/CI driving the script by accident.
//
// There is deliberately no --force/--yes escape hatch. Tests allocate a real pty
// (`script -q /dev/null …`) instead of piping.
function requireInteractive() {
  if (input.isTTY) return;

  throw new Error(
    "Refusing to touch real data without an interactive terminal.\n" +
      "  stdin is not a TTY, so approval could only come from a pipe or a script —\n" +
      "  and a piped \"yes\" is not explicit approval. Run this from a terminal.\n" +
      "  Nothing was read and nothing was run."
  );
}

// First gate, before ANY database access. Everything downstream — provider
// discovery, the primary-LE lookup, the plugin read — hits a real namespace, so
// the target is spelled out and approved before a single query goes out.
async function confirmDataAccess(opts, env) {
  const prod = isProd(opts.namespace);
  const say = (line) => promptStream.write(`${line}\n`);

  say(c.head("\n── About to read real data ─────────────────────────────"));
  say(`  namespace : ${opts.namespace}${prod ? "   ⚠  PRODUCTION" : ""}`);
  say(`  psql env  : ${env}`);
  say(`  mode      : ${opts.mode}${opts.mode === "link" ? "" : "   (read-only — cannot write)"}`);
  say(`  databases : ${[SHEDUL_DB, AD_DB, LE_DB].join(", ")}`);
  say("  access    : read-only SELECTs — no writes at this stage");

  const ans = (await ask('Read from these databases? (type "yes"): ')).trim().toLowerCase();
  return prod ? ans === "yes" : ans === "yes" || ans === "y";
}

// Confirmation gate for the write. Non-prod takes a single "yes"/"y"; production
// makes you type the namespace back first and then requires an exact "yes".
async function confirmRun(opts) {
  const prod = isProd(opts.namespace);

  if (prod) {
    console.log(
      `\n⚠  PRODUCTION — namespace=${opts.namespace}, ` +
        (opts.apply ? "DRY_RUN=false: this WRITES." : "DRY_RUN=true: log only.")
    );
    const echo = (await ask(`Type the namespace (${opts.namespace}) to confirm: `)).trim();
    if (echo !== opts.namespace) {
      console.error("Namespace mismatch. Aborting.");
      return false;
    }
  } else if (opts.apply) {
    console.log(`\n⚠  DRY_RUN=false — this writes to ${opts.namespace}.`);
  }

  const ans = (await ask('Run this task? (type "yes"): ')).trim().toLowerCase();
  return prod ? ans === "yes" : ans === "yes" || ans === "y";
}

// --- main ------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();

  // Nothing below this line may touch a database without a human present.
  requireInteractive();
  if (opts.json) promptStream = process.stderr;

  // --json still resolves its inputs from flags rather than prompts (its stdout
  // has to stay pure JSON), but it is not exempt from the approval gate.
  if (opts.json && !opts.providerIds && !opts.file && !opts.all) {
    throw new Error(
      "--json needs provider IDs (argument or --file), or --all (it does not prompt for them)."
    );
  }

  if (!opts.json) {
    console.log("plugin_legal_entity_updates — plugins ↔ primary legal entities");
  }

  // 1. Which mode? Asked first — it decides everything downstream. Any flag that
  //    only makes sense in one mode has already answered this.
  if (!opts.mode) opts.mode = await askMode();

  // Fail loudly on flags that mean nothing in migrate mode rather than ignoring
  // them — silently dropping --all on a migration would be a nasty surprise.
  if (opts.mode === "migrate") {
    const bad = [
      opts.all && "--all",
      opts.file && "--file",
      opts.json && "--json",
    ].filter(Boolean);
    if (bad.length) {
      throw new Error(
        `${bad.join(", ")} cannot be used with migrate — it takes an explicit ` +
          "provider list only. Pass the IDs as arguments, or let it prompt you."
      );
    }
  }

  // 2. Environment — -n, or prompt. Before the reads, because discovering
  //    providers is itself a query against the chosen namespace.
  if (!opts.namespaceGiven && !opts.json) {
    opts.namespace = await askNamespace();
  }
  const env = psqlEnv(opts.namespace);

  // 3. Approve the data access itself, before any query goes out ------------
  if (!(await confirmDataAccess(opts, env))) {
    console.log("Aborted. Nothing was read.");
    return;
  }

  // MIGRATE takes its own path from here. It shares the gates above and nothing
  // else — no provider discovery, no plugin reads, no resolve.
  if (opts.mode === "migrate") {
    const providerIds = opts.providerIds
      ? parseProviderIds(opts.providerIds)
      : await askMigrateProviderIds();

    console.log(
      `\nTarget: namespace=${opts.namespace} psql_env=${env} service=${MIGRATE_SERVICE}`
    );
    console.log(`Providers to migrate: ${providerIds.length} — ${providerIds.join(", ")}`);

    // Preview stands in for the dry run this task doesn't have.
    console.log(c.faint(`\nReading migration state from ${SHEDUL_DB} (read-only)…`));
    const before = fetchMigrationStatuses(env, providerIds);
    printMigratePreview(providerIds, before);

    console.log(c.head("\n── Command ─────────────────────────────────────────────"));
    console.log(`\n${c.cmd(buildMigrateCommand(opts, providerIds))}\n`);

    if (opts.printOnly) {
      console.log("[print-only] Nothing was run.");
      return;
    }

    printMigrateWarning(opts);

    if (!(await confirmRun(opts))) {
      console.log("Aborted. Nothing was run.");
      return;
    }

    runInherit("houston", [...migrateTaskArgs(opts, providerIds), "--no-tui", "-w"]);

    console.log(c.faint(`\nVerifying against ${SHEDUL_DB} (read-only)…`));
    const after = fetchMigrationStatuses(env, providerIds);
    if (printMigrateReadback(providerIds, before, after)) process.exitCode = 1;
    return;
  }

  // 4. Provider IDs — argument, --file, --all, or prompt --------------------
  let raw = opts.providerIds;
  if (opts.file) {
    const fromFile = fs.readFileSync(opts.file, "utf8");
    raw = raw ? `${raw},${fromFile}` : fromFile;
  }

  let providerIds;
  if (raw) {
    providerIds = parseProviderIds(raw);
  } else if (opts.all) {
    if (!opts.json) console.log(c.faint(`\nFinding providers in ${AD_DB}.account_configurations…`));
    providerIds = fetchAllProviderIds(env);
    if (!providerIds.length) throw new Error("No providers found in account_configurations.");
  } else {
    providerIds = await askProviderIds(env);
  }

  if (!opts.json) {
    console.log(
      `\nTarget: namespace=${opts.namespace} psql_env=${env} service=${opts.service}`
    );
    console.log(`Providers requested: ${providerIds.length} — ${providerIds.join(", ")}`);
  }

  // 5. Resolve primary legal entities (shedul) -----------------------------
  if (!opts.json) console.log(c.faint(`\nReading primary legal entities from ${SHEDUL_DB} (read-only)…`));
  const primaryByProvider = fetchPrimaryLegalEntities(env, providerIds);

  // PRE-FLIGHT stops here. It never touches plugins — it asks only whether the
  // data on the two sides agrees, which is what you want to know *before*
  // linking anything. Strictly SELECTs.
  if (opts.mode === "preflight") {
    const withLegalEntity = providerIds.filter((id) => primaryByProvider.has(id));
    const missingLegalEntity = providerIds.length - withLegalEntity.length;

    if (!withLegalEntity.length) {
      console.log(
        c.warn("\nNone of these providers has an active primary legal entity — nothing to compare.")
      );
      return;
    }

    console.log(c.faint(`Reading provider_billing_informations from ${SHEDUL_DB} (read-only)…`));
    const billing = fetchBillingInformations(env, withLegalEntity);

    console.log(c.faint(`Reading legal entity fields from ${LE_DB} (read-only)…`));
    const leFields = fetchLegalEntityFields(env, [
      ...new Set(withLegalEntity.map((id) => primaryByProvider.get(id))),
    ]);

    const comparisons = withLegalEntity.map((id) =>
      compareFields(id, billing.get(id), leFields.get(primaryByProvider.get(id)))
    );

    // Auto: detail when you named the providers, summary for a bulk --all sweep.
    const detail = opts.detail === null ? !opts.all : opts.detail;

    if (detail) {
      console.log(
        c.head("\n── Field-by-field check ────────────────────────────────") +
          c.faint("\n  (--summary for one line per provider instead)")
      );
      for (const cmp of comparisons) printProviderFieldTable(cmp);
    }

    const tally = printFieldComparison(comparisons);

    if (printPreflightVerdict(tally, missingLegalEntity)) process.exitCode = 1;
    return;
  }

  // 6. Resolve plugins (accounting_documents) ------------------------------
  if (!opts.json) console.log(c.faint(`Reading plugins from ${AD_DB} (read-only)…`));
  const pluginsByProvider = fetchPlugins(env, providerIds);

  // POST-FLIGHT stops here: is every plugin pointing at its provider's primary
  // legal entity? No task, no command, no writes.
  if (opts.mode === "postflight") {
    const audit = auditProviders(providerIds, primaryByProvider, pluginsByProvider);
    const drift = printAudit(opts, audit);

    printCrossCheck(opts, audit.filter((a) => a.plugin).map((a) => ({
      plugin_id: a.plugin.id,
      _providerId: a.providerId,
    })));

    console.log(
      drift
        ? c.bad("\n══ POST-FLIGHT: FAIL ═══════════════════════════════════")
        : c.ok("\n══ POST-FLIGHT: PASS ═══════════════════════════════════")
    );
    console.log(
      drift
        ? `  ${c.bad("✗")} ${drift} provider(s) not correctly linked. See the table above.`
        : `  ${c.ok("✓")} every provider that can be linked is linked correctly.`
    );
    console.log(
      c.faint("\n  Read-only: this mode issues SELECTs and nothing else.") +
        c.faint("\n  For data consistency between billing info and the legal entity, run pre-flight.")
    );

    if (drift) process.exitCode = 1;
    return;
  }

  // 7. Pair them up --------------------------------------------------------
  const { updates, skipped } = resolve(providerIds, primaryByProvider, pluginsByProvider);

  if (opts.json) {
    // Machine-readable mode: payload on stdout, diagnostics on stderr, so the
    // JSON can be piped straight into another command.
    if (skipped.length) {
      console.error(`# ${skipped.length} provider(s) skipped — rerun without --json for detail`);
    }
    console.log(updatesJson(updates));
    return;
  }

  if (updates.length) {
    console.log(c.head("\n── Resolved ────────────────────────────────────────────"));
    for (const u of updates) {
      console.log(
        `  provider=${u._providerId}  ${fmtPlugin(u._plugin)}\n` +
          `      → legal_entity_id=${u.legal_entity_id}`
      );
    }
  }

  printExemptProviders(skipped);

  const collisions = findLegalEntityCollisions(updates);
  if (collisions.length) {
    console.log(c.warn("\n⚠  legal_entity_id collisions — the task will apply one and skip the rest:"));
    for (const [legalEntityId, us] of collisions) {
      const where = us.map((u) => `provider=${u._providerId} plugin=${u.plugin_id}`).join(", ");
      console.log(`      ${legalEntityId} → ${where}`);
    }
  }

  console.log(
    `\nSummary: ${updates.length} update(s), ${skipped.length} skipped, ` +
      `of ${providerIds.length} provider(s) requested.`
  );

  if (!updates.length) {
    console.log("\nNothing to link. No command to run.");
    return;
  }

  // 8. Dry run or apply — --apply/--dry-run, or prompt ---------------------
  // Asked here, after the report, so the decision is made with the actual
  // plugin list on screen.
  if (!opts.modeGiven && !opts.printOnly) {
    opts.apply = await askApply(opts.namespace);
  }

  // 9. Print the command ---------------------------------------------------
  console.log(
    c.head("\n── Command ─────────────────────────────────────────────") +
      (opts.apply ? "" : c.faint("\n(DRY_RUN=true — logs only, writes nothing)"))
  );
  console.log(`\n${c.cmd(buildCommand(opts, updates))}\n`);

  if (opts.printOnly) {
    console.log("[print-only] Nothing was run.");
    return;
  }

  // 10. Confirm + run -------------------------------------------------------
  // --no-tui -w are appended so the task's logs stream into this terminal;
  // runInherit echoes the full argv before it spawns.
  if (!(await confirmRun(opts))) {
    console.log("Aborted. Nothing was run.");
    return;
  }

  runInherit("houston", [...taskArgs(opts, updates), "--no-tui", "-w"]);

  // 11. Verify — read the rows back and prove what actually landed -----------
  // The task exits 0 even when it skips every single row, so a green exit is
  // not evidence. Only the read-back is.
  console.log(c.faint(`\nVerifying against ${AD_DB} (read-only)…`));
  const applied = fetchAppliedLegalEntities(env, updates.map((u) => u.plugin_id));
  const failures = printVerification(opts, updates, applied);

  const scope = `${updates.length} plugin(s) on ${opts.namespace}`;
  if (failures) {
    // A partial result is not a success, however green the task's exit code was.
    console.log(
      `\n✗ ${TASK}: ${updates.length - failures}/${updates.length} verified, ` +
        `${failures} did not. Nothing to undo — the rest simply weren't written.`
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `\n✓ Ran ${TASK} for ${scope}` +
      (opts.apply ? " — all verified." : " (DRY_RUN=true — nothing written, verified unchanged).")
  );
}

main()
  .catch((err) => {
    console.error(`\nError: ${err.message}`);
    process.exitCode = 1;
  })
  // The single readline holds the event loop open; always let go of stdin.
  .finally(closeRl);
