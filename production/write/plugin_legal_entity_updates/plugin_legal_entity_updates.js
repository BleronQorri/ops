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
// Usage:
//   ./plugin_legal_entity_updates.js                        # guided — just run it
//   ./plugin_legal_entity_updates.js 12345,67890            # skip the provider prompt
//   ./plugin_legal_entity_updates.js --all                  # every provider with a config
//   ./plugin_legal_entity_updates.js -n production --apply 12345
//   ./plugin_legal_entity_updates.js --print-only 12345     # don't run it

const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const { spawnSync } = require("child_process");
const fs = require("fs");

// --- constants -------------------------------------------------------------

// The primary-legal-entity pointer is owned by shedul; plugins live in
// accounting_documents. Two databases, two reads.
const SHEDUL_DB = "shedul";
const AD_DB = "accounting_documents";

const DEFAULT_NAMESPACE = "eng-orion";
const DEFAULT_SERVICE = "accounting-documents";
const TASK = "link_plugins_to_legal_entities_from_env";

// Namespaces that get the second confirmation gate.
const PROD_NAMESPACES = new Set(["production", "prod"]);

// --- arg parsing -----------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    namespace: DEFAULT_NAMESPACE,
    service: DEFAULT_SERVICE,
    apply: false,
    json: false,
    printOnly: false,
    all: false,
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
    } else if (a === "--dry-run") {
      opts.apply = false;
      opts.modeGiven = true;
    } else if (a === "--all") opts.all = true;
    else if (a === "--print-only") opts.printOnly = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
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
      --apply            DRY_RUN="false" — actually write
      --dry-run          DRY_RUN="true" — logs only (the default)
  -s, --service NAME     Houston service (default: ${DEFAULT_SERVICE})
      --print-only       Print the Houston command and stop; run nothing
      --json             Print only the UPDATES JSON array; never prompts, so it
                         needs provider IDs or --all
  -h, --help             Show this help

The guided flow:
  1. environment      — staging (${DEFAULT_NAMESPACE}), production, or any namespace
  2. providers        — all of them, or a list you type
  3. reads (read-only) houston psql <env> ${SHEDUL_DB}
                       → provider_purchases_primary_legal_entities
                       houston psql <env> ${AD_DB}
                       → account_configurations + account_configuration_plugins
  4. report           — what resolved, and why anything was skipped
  5. dry run or apply — asked with the report on screen
  6. confirm          — non-prod: one "yes". PRODUCTION: type the namespace
                        back, THEN "yes".
  7. runs the task    — the exact command is printed before it runs

Providers are skipped (and reported) when they have no active primary legal
entity, no account configuration, no plugin with a NULL legal_entity_id, or more
than one such plugin — the unique index means only one plugin can hold a given
legal entity, so an ambiguous provider is never auto-resolved.`);
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

function ensureRl() {
  if (rl) return rl;

  rl = readline.createInterface({ input, output });
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
  output.write(question);

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
// back as an empty field.
function psqlRead(env, db, sql) {
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
    "SELECT provider_id, legal_entity_id " +
    "FROM provider_purchases_primary_legal_entities " +
    `WHERE provider_id IN (${providerIds.join(",")}) AND valid_to IS NULL;`;

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
    "SELECT DISTINCT provider_id FROM account_configurations " +
    "WHERE provider_id IS NOT NULL ORDER BY provider_id;";

  return parseRows(psqlRead(env, AD_DB, sql), 1)
    .map(([providerId]) => providerId)
    .filter((id) => /^\d+$/.test(id));
}

// provider_id -> [{ id, pluginType, integrator, pluginStatus, legalEntityId }]
function fetchPlugins(env, providerIds) {
  const sql =
    "SELECT ac.provider_id, p.id, p.plugin_type, p.integrator, p.plugin_status, " +
    "coalesce(p.legal_entity_id::text, '') " +
    "FROM account_configuration_plugins p " +
    "JOIN account_configurations ac ON ac.id = p.account_configuration_id " +
    `WHERE ac.provider_id IN (${providerIds.join(",")}) ` +
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

    if (!legalEntityId) {
      skipped.push({
        providerId,
        reason:
          "no active primary legal entity (no row in provider_purchases_primary_legal_entities " +
          "with valid_to IS NULL) — the RPC would answer NOT_FOUND",
        plugins,
      });
      continue;
    }

    if (!plugins.length) {
      skipped.push({
        providerId,
        reason: "no account_configuration_plugins (provider has no e-invoicing config yet)",
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
          ? "already linked — a plugin already holds this legal_entity_id"
          : "every plugin already has a legal_entity_id (never overwritten)",
        plugins,
      });
      continue;
    }

    if (candidates.length > 1) {
      skipped.push({
        providerId,
        reason:
          `${candidates.length} plugins have a NULL legal_entity_id — only one plugin can ` +
          "hold a legal entity (unique index), so pick one by hand",
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

// --- interactive steps ------------------------------------------------------

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
    console.log(`\nFinding providers in ${AD_DB}.account_configurations (read-only)…`);
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

// Confirmation gate. Non-prod takes a single "yes"/"y"; production makes you type
// the namespace back first and then requires an exact "yes".
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

  // --json is the pipeable mode: it must not prompt, so everything it needs has
  // to arrive as flags/args.
  if (opts.json && !opts.providerIds && !opts.file && !opts.all) {
    throw new Error(
      "--json needs provider IDs (argument or --file), or --all (it never prompts)."
    );
  }

  if (!opts.json) {
    console.log("plugin_legal_entity_updates — link plugins to their primary legal entity");
  }

  // 1. Environment — -n, or prompt. First, because discovering providers is
  //    itself a query against the chosen namespace.
  if (!opts.namespaceGiven && !opts.json) {
    opts.namespace = await askNamespace();
  }
  const env = psqlEnv(opts.namespace);

  // 2. Provider IDs — argument, --file, --all, or prompt --------------------
  let raw = opts.providerIds;
  if (opts.file) {
    const fromFile = fs.readFileSync(opts.file, "utf8");
    raw = raw ? `${raw},${fromFile}` : fromFile;
  }

  let providerIds;
  if (raw) {
    providerIds = parseProviderIds(raw);
  } else if (opts.all) {
    if (!opts.json) console.log(`\nFinding providers in ${AD_DB}.account_configurations…`);
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

  // 3. Resolve primary legal entities (shedul) -----------------------------
  if (!opts.json) console.log(`\nReading primary legal entities from ${SHEDUL_DB} (read-only)…`);
  const primaryByProvider = fetchPrimaryLegalEntities(env, providerIds);

  // 4. Resolve plugins (accounting_documents) ------------------------------
  if (!opts.json) console.log(`Reading plugins from ${AD_DB} (read-only)…`);
  const pluginsByProvider = fetchPlugins(env, providerIds);

  // 5. Pair them up --------------------------------------------------------
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
    console.log("\n── Resolved ────────────────────────────────────────────");
    for (const u of updates) {
      console.log(
        `  provider=${u._providerId}  ${fmtPlugin(u._plugin)}\n` +
          `      → legal_entity_id=${u.legal_entity_id}`
      );
    }
  }

  if (skipped.length) {
    console.log("\n── Skipped ─────────────────────────────────────────────");
    for (const s of skipped) {
      console.log(`  provider=${s.providerId}: ${s.reason}`);
      for (const p of s.plugins) console.log(`      ${fmtPlugin(p)}`);
    }
  }

  const collisions = findLegalEntityCollisions(updates);
  if (collisions.length) {
    console.log("\n⚠  legal_entity_id collisions — the task will apply one and skip the rest:");
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

  // 6. Dry run or apply — --apply/--dry-run, or prompt ---------------------
  // Asked here, after the report, so the decision is made with the actual
  // plugin list on screen.
  if (!opts.modeGiven && !opts.printOnly) {
    opts.apply = await askApply(opts.namespace);
  }

  // 7. Print the command ---------------------------------------------------
  console.log(
    `\n── Command ─────────────────────────────────────────────` +
      (opts.apply ? "" : "\n(DRY_RUN=true — logs only, writes nothing)")
  );
  console.log(`\n${buildCommand(opts, updates)}\n`);

  if (opts.printOnly) {
    console.log("[print-only] Nothing was run.");
    return;
  }

  // 8. Confirm + run -------------------------------------------------------
  // --no-tui -w are appended so the task's logs stream into this terminal;
  // runInherit echoes the full argv before it spawns.
  if (!(await confirmRun(opts))) {
    console.log("Aborted. Nothing was run.");
    return;
  }

  runInherit("houston", [...taskArgs(opts, updates), "--no-tui", "-w"]);

  console.log(
    `\n✓ Ran ${TASK} on ${opts.namespace} for ${updates.length} plugin(s)` +
      (opts.apply ? "." : " (DRY_RUN=true — nothing written).")
  );
}

main()
  .catch((err) => {
    console.error(`\nError: ${err.message}`);
    process.exitCode = 1;
  })
  // The single readline holds the event loop open; always let go of stdin.
  .finally(closeRl);
