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
const os = require("os");
const path = require("path");

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
  // buildingNumber / district exist as legal-entity keys ONLY where a country
  // config defines them — today just SA, whose registered_address_fields marks
  // both is_required: true because "ZATCA e-invoicing needs a complete seller
  // address" (app-legal-entities .../fields_configuration/country/sa.ex). The
  // default config has neither and uses registeredAddress.street2 instead.
  //
  // So they're `informational` — "provider only" is the designed state — EXCEPT
  // where the country's required set names them, which un-marks it. See
  // requiredFieldsFor() and compareFields().
  {
    label: "building number",
    pbi: "building_number",
    le: [
      "organization.registeredAddress.buildingNumber",
      "soleProprietorship.registeredAddress.buildingNumber",
      "individual.residentialAddress.buildingNumber",
    ],
    informational: true,
  },
  {
    label: "district",
    pbi: "district",
    le: [
      "organization.registeredAddress.district",
      "soleProprietorship.registeredAddress.district",
      "individual.residentialAddress.district",
    ],
    informational: true,
  },
  { label: "company number", pbi: "company_number", le: [], informational: true },
];

// What app-accounting-documents demands of the legal entity before it will
// onboard/send. Both modules fetch via GetLegalEntityInvoiceDetails and hard-fail
// with {:error, :missing_required_fields}, so a field missing here is not a
// cosmetic difference — it blocks e-invoicing.
//
//   SA      → EInvoicing.Comarch.LegalEntityBillingDetails  @required_fields
//   ES / IT → EInvoicing.Common.LegalEntityBillingDetails   @required_fields
//
// KSA notably does NOT check company_name (it comes from the request) but DOES
// require company_registration_number, building_number and district. Its
// tax_number is also a different identifier kind — the ZATCA TRN
// (IDENTIFIER_KIND_TAX_NUMBER) rather than the ES/IT NIF/PIVA
// (IDENTIFIER_KIND_TAX_IDENTIFICATION_NUMBER) — so a present-and-equal
// tax number here is necessary but not sufficient.
const EINVOICING_REQUIRED = {
  SA: [
    "state_province",
    "city",
    "postal_code",
    "address",
    "tax_number",
    "company_registration_number",
    "building_number",
    "district",
  ],
  ES: ["company_name", "state_province", "city", "postal_code", "address", "tax_number"],
  IT: ["company_name", "state_province", "city", "postal_code", "address", "tax_number"],
};

// Country decides the required set. Non-e-invoicing countries have none, so the
// comparison stays informational for them.
function requiredFieldsFor(countryCode) {
  return EINVOICING_REQUIRED[String(countryCode || "").toUpperCase()] || null;
}

// Presence is not the only bar. AccountingDocuments.Helpers.ValidationHelpers
// enforces KSA *formats*, which a present-but-malformed value fails:
//
//   valid_ksa_crn?    — exactly 10 characters
//   valid_ksa_tax_id? — ~r/^3\d{12}03$/ : 15 digits, starts "3", ends "03"
//
// Checked against the LEGAL ENTITY value, because that is what the onboarding path
// reads; a malformed billing-info value is reported separately since migrate would
// copy it forward.
const EINVOICING_FORMATS = {
  SA: {
    company_registration_number: {
      test: (v) => String(v).length === 10,
      expected: "exactly 10 characters (valid_ksa_crn?)",
    },
    tax_number: {
      test: (v) => /^3\d{12}03$/.test(String(v)),
      expected: 'ZATCA TRN: 15 digits, starts "3", ends "03" (valid_ksa_tax_id?)',
    },
  },
};

function formatRuleFor(countryCode, field) {
  const rules = EINVOICING_FORMATS[String(countryCode || "").toUpperCase()];
  return (rules && rules[field]) || null;
}

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

// Reset mode: everything the legal-entities migration writes for a provider, in
// the order it has to be undone. Derived from a real run's audit trail
// (billing_migration_statuses.metadata), not guessed — see AGENTS.md.
//
// `billing_migration_statuses` is LAST: it is what makes the task re-run, so it
// must only disappear once every reference to the entity is gone.
const RESET_SHEDUL_STEPS = [
  {
    table: "provider_purchases_primary_legal_entities",
    action: "delete",
    where: "provider_id = %ID%",
    note: "the primary pointer (history rows included)",
  },
  {
    table: "location_legal_entity_assignments",
    action: "delete",
    where: "provider_id = %ID%",
    note: "AssignLocationsService",
  },
  {
    table: "blast_marketing_transactions",
    action: "null",
    column: "legal_entity_id",
    where: "provider_id = %ID% AND legal_entity_id IS NOT NULL",
    note: "release back to the provider-wide bucket",
  },
  {
    table: "billing_migration_statuses",
    action: "delete",
    where: "provider_id = %ID%",
    note: "LAST — this is what lets the migration re-run",
  },
];

// Tables that carry legal_entity_id but which this migration never writes.
// Listed so the reset is explicit about what it leaves alone: provider_purchases
// in particular are real financial records.
const RESET_UNTOUCHED = [
  "provider_purchases",
  "provider_fees",
  "provider_purchase_payment_preferences",
  "blast_marketing_campaigns",
];

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

// --- exit codes ------------------------------------------------------------
//
// Three outcomes, kept distinct so a caller can branch on them. Before this the
// script exited 1 for everything, which made "the data is wrong" and "you
// mistyped a flag" indistinguishable — fine for a human reading the message,
// useless to anything driving the script.
const EXIT_DATA = 1; // drift, mismatch, a row that didn't land
const EXIT_USAGE = 2; // the call was wrong, or approval was impossible

// Thrown for anything wrong with the invocation itself: an unknown flag, a flag
// missing its value, or an approval that could not be obtained. Carries the exit
// code so the top-level handler doesn't have to guess.
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.exitCode = EXIT_USAGE;
  }
}

// --- arg parsing -----------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    namespace: DEFAULT_NAMESPACE,
    service: DEFAULT_SERVICE,
    apply: false,
    json: false,
    yes: false,
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
    // Reset mode: also soft-delete the orphaned legal entities. On by default —
    // leaving them live is what produced provider 33's duplicate.
    deleteLegalEntities: true,
    // Pre-flight Markdown export. --md sets the flag; an optional value sets the
    // path. Without the flag you're offered the export at the end anyway.
    md: false,
    // --md PATH overrides the dated default name.
    mdPath: null,
    file: null,
    providerIds: null,
    help: false,
    // Track what was supplied so the interactive flow only asks for the rest.
    // Every flag that a prompt would otherwise overwrite needs one of these:
    // without it, passing the flag and then being asked anyway is worse than
    // having no flag at all.
    namespaceGiven: false,
    modeGiven: false,
    applyGiven: false,
    migratePaymentMethodsGiven: false,
    deleteLegalEntitiesGiven: false,
  };
  // Every flag is optional and only pre-answers a prompt: run the script bare and
  // it still asks you everything, in order. Flags exist so a non-human caller can
  // answer in advance — and so a human who already knows what they want can skip
  // ahead. See --yes for the one thing flags alone cannot buy: approval.
  //
  // Mode selectors. --verify is a long-standing alias for --postflight.
  const MODES = {
    "--guided": "guided",
    "--migrate": "migrate",
    "--preflight": "preflight",
    "--postflight": "postflight",
    "--verify": "postflight",
    "--link": "link",
    "--plugins": "plugins",
    "--reset": "reset",
  };

  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    // Consume the next token as this flag's value. Rejects a missing value and a
    // following flag, so `-n --json` is an error rather than a namespace of
    // "--json".
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) {
        throw new UsageError(`Option "${a}" needs a value.`);
      }
      i++;
      return v;
    };

    if (a === "-h" || a === "--help") {
      opts.help = true;
    } else if (MODES[a]) {
      opts.mode = MODES[a];
      opts.modeGiven = true;
    } else if (a === "-n" || a === "--namespace") {
      opts.namespace = value();
      opts.namespaceGiven = true;
    } else if (a === "-s" || a === "--service") {
      opts.service = value();
    } else if (a === "-f" || a === "--file") {
      opts.file = value();
    } else if (a === "--all") {
      opts.all = true;
    } else if (a === "--apply") {
      opts.apply = true;
      opts.applyGiven = true;
    } else if (a === "--dry-run") {
      opts.apply = false;
      opts.applyGiven = true;
    } else if (a === "--print-only") {
      opts.printOnly = true;
    } else if (a === "--json") {
      opts.json = true;
    } else if (a === "--yes") {
      opts.yes = true;
    } else if (a === "--detail") {
      opts.detail = true;
    } else if (a === "--summary") {
      opts.detail = false;
    } else if (a === "--md") {
      opts.md = true;
      // The path is optional, which makes `--md 33` ambiguous: a file name or a
      // provider list? Anything that is only digits, commas and spaces is a
      // provider list, so it stays in `rest` and --md keeps its dated default.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-") && !/^[\d,\s]+$/.test(next)) {
        opts.mdPath = argv[++i];
      }
    } else if (a === "--no-payment-methods") {
      opts.migratePaymentMethods = false;
      opts.migratePaymentMethodsGiven = true;
    } else if (a === "--copy-tax-number") {
      opts.copyTaxNumber = true;
    } else if (a === "--batch-size") {
      const raw = value();
      if (!/^\d+$/.test(raw)) throw new UsageError(`--batch-size needs a number, got "${raw}".`);
      opts.batchSize = Number(raw);
    } else if (a === "--keep-legal-entities") {
      opts.deleteLegalEntities = false;
      opts.deleteLegalEntitiesGiven = true;
    } else if (a.startsWith("-")) {
      throw new UsageError(
        `Unknown option "${a}".\n` +
          "  Run with --help for the full list, or with no flags at all to be asked instead."
      );
    } else {
      rest.push(a);
    }
  }
  if (rest.length) opts.providerIds = rest.join(",");

  // --file is just another way to supply the provider list; parseProviderIds
  // already strips `#` comments so the file can be annotated.
  if (opts.file) {
    let raw;
    try {
      raw = fs.readFileSync(opts.file, "utf8");
    } catch (err) {
      throw new UsageError(`Cannot read --file ${opts.file}: ${err.message}`);
    }
    // parseProviderIds throws a plain Error on an empty or malformed list; coming
    // from --file that is a bad invocation, not bad data, so it exits 2 like every
    // other argument problem.
    let fromFile;
    try {
      fromFile = parseProviderIds(raw);
    } catch (err) {
      throw new UsageError(`--file ${opts.file}: ${err.message}`);
    }
    // Arguments win over the file, and both are merged rather than one silently
    // replacing the other.
    opts.providerIds = [...new Set([...(opts.providerIds ? [opts.providerIds] : []), ...fromFile])]
      .join(",");
  }

  // Guided runs each step as a child process. It passes the step, namespace and
  // provider list through the environment variables below rather than flags —
  // internal plumbing, not a user interface. Set them by hand and you are simply
  // pre-answering prompts; nothing validates that you meant to.

  // Guided → child handoff.
  if (process.env.PLE_STEP) opts.mode = process.env.PLE_STEP;
  if (process.env.PLE_NAMESPACE) {
    opts.namespace = process.env.PLE_NAMESPACE;
    opts.namespaceGiven = true;
  }
  if (process.env.PLE_PROVIDERS) opts.providerIds = process.env.PLE_PROVIDERS;

  // Migrate and reset take an explicit provider list and nothing else. "Every
  // provider with an account configuration" is the wrong set for a migration and
  // catastrophic for a reset, so --all is rejected outright rather than ignored.
  if (opts.all && (opts.mode === "migrate" || opts.mode === "reset")) {
    throw new UsageError(
      `--all is not allowed with --${opts.mode === "migrate" ? "migrate" : "reset"}.\n` +
        "  Name the providers explicitly: this mode writes, and a stray --all would hit everything."
    );
  }

  return opts;
}

function usage() {
  console.log(`plugin_legal_entity_updates — providers ↔ primary legal entities

Usage:
  ./plugin_legal_entity_updates.js [FLAGS] [PROVIDER_IDS]

Run it bare and it asks you everything, in order — nothing to remember. Every
flag below is optional and simply pre-answers one of those questions:

  ./plugin_legal_entity_updates.js

Arguments:
  PROVIDER_IDS   Optional. Comma- or space-separated provider IDs (e.g. 33,41).
                 Omit them and you'll be asked — including an "all providers"
                 option where that makes sense.
  -h, --help     This help.

FLAGS
  Target
    -n, --namespace NAME   namespace / env; drives the psql env AND the task's
                           --namespace. Default ${DEFAULT_NAMESPACE}.
    -s, --service NAME     Houston service. Default ${DEFAULT_SERVICE}.
  Providers
        --all              every provider in account_configurations. Rejected by
                           migrate and reset — they need an explicit list.
    -f, --file PATH        read provider IDs from a file ("#" starts a comment)
  Mode (any of these skips the mode prompt)
        --guided           the whole procedure, step by step
        --migrate          create the legal entities (partners-app)
        --preflight        READ-ONLY: billing info vs the PRIMARY legal entity
        --postflight       READ-ONLY: is every plugin linked? (--verify is an alias)
        --link             run ${TASK}
        --plugins          READ-ONLY: billing info vs each PLUGIN's legal entity
        --reset            STAGING ONLY, destructive: undo the migration
  Link
        --apply            DRY_RUN="false" — actually write
        --dry-run          DRY_RUN="true" — logs only (the default)
        --print-only       print the command and stop; run nothing
  Migrate
        --no-payment-methods   MIGRATE_PAYMENT_METHODS=false (defaults to true,
                               which migrates cards on file through an RPC)
        --copy-tax-number      COPY_TAX_NUMBER=true
        --batch-size N         BATCH_SIZE=N
  Reset
        --keep-legal-entities  don't soft-delete the orphaned legal entities
  Reporting
        --md [PATH]        write the report as Markdown; default
                           preflight-<namespace>-<YYYY-MM-DD>.md
        --detail           force the per-provider field checklist on
        --summary          force it off (default: on unless --all)
  Non-interactive
        --json             emit one result document on stdout; every human-readable
                           line goes to stderr instead. Exit code is in "exit".
        --yes              run without a terminal. READ-ONLY MODES ONLY —
                           see below.

WRITES STILL REQUIRE A TERMINAL. --yes covers the modes that only issue SELECTs:
pre-flight, post-flight, plugin audit, and link with --dry-run. Every write path
(--link --apply, --migrate, --reset) refuses without a TTY in every namespace,
production or not, and --yes never answers a write confirmation. Exit ${EXIT_USAGE}.

EXIT CODES
  0   pass, or nothing to do
  ${EXIT_DATA}   the data is wrong — drift, a mismatch, a row that didn't land, or a
      pre-flight that could compare nothing at all (no primary legal entity
      for any provider given: run migrate first)
  ${EXIT_USAGE}   the call is wrong — bad flag, or approval was impossible

WHAT IT ASKS, IN ORDER (for anything a flag didn't already answer)
  1. Which mode          grouped into MIGRATION / REPORTING / STAGING ONLY, each
                         option tagged with its stage and what it does.
  2. Which environment   staging (${DEFAULT_NAMESPACE}), production, or any namespace.
  3. Approve the reads   the namespace and every database are shown and confirmed
                         BEFORE a single query runs.
  4. Which providers     all of them, or a list you type.
  5. Mode-specific       dry run vs apply (link), payment methods (migrate),
                         soft-delete entities (reset), export as Markdown.
  6. Approve the run     non-prod one "yes"; PRODUCTION makes you type the
                         namespace back first.

THE MODES
  Guided       The whole procedure, step by step, each step explained before you
               run it: pre-flight → link → post-flight. Runs each as its own
               invocation. Does NOT run migrate or reset — both are described.

  Migrate      Creates the legal entities: ${MIGRATE_TASK}
               on ${MIGRATE_SERVICE}. Run first; nothing else works without an
               entity. NO dry run — it writes on the first call — so a read-only
               preview of each provider's migration state is shown first.

  Pre-flight   READ-ONLY. provider_billing_informations (${SHEDUL_DB}) vs the
               provider's PRIMARY legal entity (${LE_DB}), field by field, plus
               the per-country required set and the KSA format rules, plus the
               KYC / payments gate. PASS/FAIL.

  Link         Runs ${TASK}.
               Asks dry run or apply, then reads the rows back to prove what
               landed — the task exits 0 even when it skips everything.

  Post-flight  READ-ONLY. Each plugin's legal_entity_id vs its provider's
               primary. PASS/FAIL.

  Plugin audit READ-ONLY. Billing info vs the legal entity each PLUGIN points at
               — what the send path actually reads. One section per plugin.

  Reset        STAGING ONLY, DESTRUCTIVE, no undo. Clears the migration state,
               primary pointer and plugin link so migrate can genuinely re-run.
               Refuses production outright.

Every read-only mode can write its report to a Markdown file — you're offered the
export at the end.

Providers are skipped (and listed with a reason) when they have no active primary
legal entity, no account configuration, no plugin with a NULL legal_entity_id, or
more than one such plugin — one legal entity can back at most one plugin, so an
ambiguous provider is never auto-resolved.`);
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

// --- json output -------------------------------------------------------------
//
// The contract: with --json, stdout carries exactly one JSON document and
// nothing else; every line a human would read goes to stderr. One run therefore
// gives you both — `2>/dev/null | jq .` for the data, `1>/dev/null` for the
// report — instead of forcing a choice between them.
//
// Rerouting `console` once, here, is deliberate. The alternative is threading a
// stream through ~200 call sites, where one missed call silently corrupts the
// payload and the corruption only shows up in whatever is parsing it.

let jsonMode = false;

function startJsonMode() {
  jsonMode = true;
  promptStream = process.stderr;
  const toStderr = (...args) => process.stderr.write(`${args.join(" ")}\n`);
  console.log = toStderr;
  console.info = toStderr;
  // console.error and console.warn already write to stderr.
}

// The common envelope. `exit` mirrors process.exitCode, so a caller reading the
// document never has to also check $?, and the two can never disagree — which is
// why this is called after the exit code has been decided, not before.
function emitJson(opts, body) {
  if (!jsonMode) return;
  const doc = {
    schema_version: 1,
    mode: opts.mode,
    namespace: opts.namespace,
    service: opts.service,
    exit: process.exitCode || 0,
    ...body,
  };
  process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
}

const verdictOf = (failed) => (failed ? "FAIL" : "PASS");

// Field rows, built from the comparison structures rather than the rendered
// tables: those carry ANSI escapes and column padding, and a value that has been
// through a formatter is no longer the value. `rule` is dropped to its expected
// form — it holds a RegExp, which JSON.stringify would flatten to {}.
function jsonFieldRows(rows) {
  return rows.map((r) => ({
    field: r.label,
    billing_info: r.pbi || null,
    legal_entity: r.le || null,
    legal_entity_key: r.leKey || null,
    same: Boolean(r.same),
    required: Boolean(r.required),
    blocking: Boolean(r.blocking),
    informational: Boolean(r.informational),
    invalid_format: r.leBadFormat ? "legal_entity" : r.pbiBadFormat ? "billing_info" : null,
    expected_format: r.rule ? r.rule.expected : null,
    note: r.note || null,
  }));
}

// One entry per comparison — shared by pre-flight and the plugin audit, which
// compare the same fields against a different legal entity.
function jsonComparison(cmp) {
  return {
    provider_id: cmp.providerId,
    country_code: cmp.countryCode || null,
    entity_type: cmp.entityType || null,
    required_fields: cmp.required || [],
    blocking: cmp.blocking.map((r) => r.label),
    differs: cmp.diffs.map((r) => r.label),
    status: cmp.blocking.length ? "blocked" : cmp.diffs.length ? "differs" : "clean",
    fields: jsonFieldRows(cmp.rows),
  };
}

function ensureRl() {
  if (rl) return rl;

  // Reset the closed flag: closeRl() fires the `close` handler below, and guided
  // mode closes the interface before every spawned step so the child owns stdin.
  // Without this, the first prompt after a step would abort as end-of-input on a
  // perfectly healthy terminal.
  inputClosed = false;

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
  choices.forEach((choice, i) => {
    // A `section` on a choice starts a new group above it. Purely presentational —
    // numbering stays continuous so "4" always means the same thing.
    if (choice.section) console.log(`\n  ${c.head(choice.section)}`);
    console.log(
      `  ${i + 1}) ${choice.label}` +
        (choice.stage ? `   ${c.faint(`[${choice.stage}]`)}` : "") +
        (choice === def ? `   ${c.ok("[default]")}` : "")
    );
    // Optional second line: what it actually does. Keeps the label short enough
    // to scan while still answering "which one do I want?" without --help.
    if (choice.detail) console.log(c.faint(wrapText(choice.detail, "", 7)));
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

// provider_id -> account_configurations.country_code. This is the country that
// decides which validator runs: BillingDetailsPolicy dispatches on
// `%{country_code: "SA"} = account_configuration`, so the account configuration —
// not the billing info, not the legal entity — is the routing truth.
function fetchAccountConfigCountries(env, providerIds) {
  const sql =
    "SELECT provider_id::text, coalesce(country_code, '')\n" +
    "FROM account_configurations\n" +
    `WHERE provider_id IN (${providerIds.join(",")})\n` +
    "ORDER BY provider_id;";

  const map = new Map();
  for (const [providerId, countryCode] of parseRows(psqlRead(env, AD_DB, sql), 2)) {
    if (countryCode) map.set(providerId, countryCode.toUpperCase());
  }
  return map;
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
function compareFields(providerId, billing, fields, countryCode) {
  const rows = [];
  // "individual" vs everything else (organization, trust, sole_proprietorship,
  // unincorporated_partnership) — see `only` on FIELD_COMPARISON.
  const entityType = (fields && fields.get("_column.type")) || "";
  const kind = entityType === "individual" ? "individual" : "organization";

  const required = requiredFieldsFor(countryCode);

  for (const spec of FIELD_COMPARISON) {
    if (spec.only && spec.only !== kind) continue;

    const isRequired = Boolean(required && required.includes(spec.pbi));
    const pbiValue = billing ? billing[spec.pbi] || "" : "";
    const { value: leVal, key: leKey } = leValue(fields, spec.le);

    // A required field is reported even when BOTH sides are empty — that's the
    // worst case for onboarding, not something to quietly skip.
    if (!pbiValue && !leVal && !isRequired) continue;

    const same = normalizeValue(pbiValue) === normalizeValue(leVal);
    const presence = pbiValue && leVal ? "both" : pbiValue ? "provider only" : leVal ? "legal entity only" : "neither";

    // Format, not just presence — a present-but-malformed value still fails.
    const rule = formatRuleFor(countryCode, spec.pbi);
    const leBadFormat = Boolean(rule && leVal && !rule.test(leVal));
    const pbiBadFormat = Boolean(rule && pbiValue && !rule.test(pbiValue));

    rows.push({
      label: spec.label,
      pbi: pbiValue,
      le: leVal,
      leKey: leKey || fallbackLeKey(spec.le, kind),
      required: isRequired,
      // Informational means "no legal-entity counterpart by design" — but if the
      // country's required set names the field, a counterpart is expected and the
      // exemption no longer applies (SA's buildingNumber/district).
      informational: Boolean(spec.informational) && !isRequired,
      same,
      presence,
      rule,
      leBadFormat,
      pbiBadFormat,
      // What actually breaks e-invoicing: a REQUIRED field missing from the legal
      // entity ({:error, :missing_required_fields}), or one present but in a shape
      // ValidationHelpers rejects.
      blocking: (isRequired && !leVal) || leBadFormat,
      note: leBadFormat
        ? `INVALID FORMAT in legal entity — ${rule.expected}`
        : same
          ? pbiBadFormat
            ? `both sides invalid — ${rule.expected}`
            : ""
          : isRequired && !leVal
            ? "REQUIRED by e-invoicing — missing in legal entity"
            : !pbiValue
              ? "missing in billing info"
              : !leVal
                ? "missing in legal entity"
                : "differs",
    });
  }

  return {
    providerId,
    billing,
    entityType,
    countryCode: countryCode || "",
    required,
    rows,
    diffs: rows.filter((r) => !r.same && !r.informational),
    blocking: rows.filter((r) => r.blocking),
  };
}

// The per-provider checklist: every comparable field, matching or not, with the
// legal-entity key that supplied the value. This is the "are these good?" view —
// printFieldComparison's tables only surface what disagrees.
function printProviderFieldTable(cmp, heading) {
  const mark = (row) => {
    if (row.leBadFormat) return `${c.bad("⛔ INVALID FORMAT")}`;
    if (row.blocking) return `${c.bad("⛔ BLOCKS e-invoicing")}`;
    if (row.informational) return `${c.faint("provider only")}`;
    if (row.same) return `${c.ok("✅")} both`;
    if (row.presence === "both") return `${c.bad("❌")} differs`;
    if (row.presence === "neither") return `${c.bad("❌")} neither`;
    return `${c.warn("⚠")} ${row.presence}`;
  };

  const country = cmp.countryCode || "?";
  const scope = cmp.required
    ? c.warn(`e-invoicing country ${country}`)
    : c.faint(`${country} — not an e-invoicing country, nothing required`);

  console.log(
    c.head(
      `\n── ${heading || `provider=${cmp.providerId} (${cmp.entityType || "unknown type"}, ${country})`} ` +
        "──────────────────"
    )
  );
  console.log(`  ${scope}`);

  console.log(
    renderTable(
      ["FIELD", "REQ?", `PROVIDER BILLING (${SHEDUL_DB})`, `LEGAL ENTITY (fields jsonb)`, "PRESENT?"],
      cmp.rows.map((r) => [
        r.label,
        r.required ? c.warn("yes") : "",
        r.pbi || "—",
        r.le ? `${c.sql(r.leKey)} = ${r.le}` : r.leKey ? c.faint(`${r.leKey} = ∅`) : "—",
        mark(r),
      ])
    )
  );

  const comparable = cmp.rows.filter((r) => !r.informational);
  // A row where BOTH sides are empty is "equal" but still blocking — agreement on
  // nothing is not agreement, so it must not inflate the count.
  const matched = comparable.filter((r) => r.same && !r.blocking).length;
  const informationalCount = cmp.rows.length - comparable.length;

  console.log(
    `\n  ${matched === comparable.length ? c.ok("✓") : c.bad("✗")} ` +
      `${matched}/${comparable.length} comparable fields agree` +
      (informationalCount
        ? c.faint(`   (${informationalCount} provider-only column(s) not compared)`)
        : "")
  );

  if (cmp.blocking.length) {
    console.log(
      c.bad(
        `  ⛔ ${cmp.blocking.length} required field(s) unusable in the legal entity: ` +
          cmp.blocking.map(blockingLabel).join(", ")
      )
    );
    console.log(
      c.faint(
        `     ${country} e-invoicing onboarding/send will fail with ` +
          "{:error, :missing_required_fields}."
      )
    );
  }
}

// One banner, two states. In a helper so the dead-end block in pre-flight and
// printPreflightVerdict below cannot drift apart visually.
const verdictBanner = (failed) =>
  failed
    ? c.bad("\n══ PRE-FLIGHT: FAIL ════════════════════════════════════")
    : c.ok("\n══ PRE-FLIGHT: PASS ════════════════════════════════════");

// The providers pre-flight could not check at all. Red, not yellow: a provider
// with no primary legal entity was never compared against anything, and saying so
// quietly next to a green PASS reads as approval of data nobody looked at.
//
// `hasBilling` picks the fix line, and the two cases are genuinely different.
// migrate builds the legal entity FROM provider_billing_informations, so a
// provider that has that row is simply waiting for migrate to run; one that
// doesn't gives migrate nothing to build from, and stays stuck until someone puts
// billing details on the provider.
//
// ⊘ and not ⛔: ⛔ already means "legal entity missing REQUIRED e-invoicing
// fields", which is a different problem with a different fix.
function printNoPrimaryLegalEntity(missing) {
  if (!missing.length) return;

  const n = missing.length;
  console.log(
    c.bad(
      `\n  ⊘ ${n === 1 ? "1 provider was" : `${n} providers were`} NOT checked — ` +
        "no active primary legal entity:"
    )
  );

  for (const { providerId, hasBilling } of missing) {
    console.log(
      wrapText(
        hasBilling
          ? "billing details are present, so migrate has not run yet. " +
              `Fix: run migrate for provider ${providerId}, then re-run pre-flight.`
          : "no active provider_billing_informations row either, so migrate would " +
              "have nothing to build an entity from. Fix: get billing details onto " +
              "the provider first.",
        `provider=${providerId} — `,
        6
      )
    );
  }
}

function printFieldComparison(comparisons, missing = []) {
  console.log(
    c.head("\n── Field comparison (provider_billing_informations ↔ legal entity) ──")
  );

  // Blocked is checked FIRST. A provider can have no billing row *and* a legal
  // entity missing required fields — calling that "nothing to compare" would bury
  // the more serious fact.
  const blockedSet = new Set(comparisons.filter((cmp) => cmp.blocking.length));
  const noBilling = comparisons.filter((cmp) => !cmp.billing && !blockedSet.has(cmp));
  const withDiffs = comparisons.filter((cmp) => cmp.billing && cmp.diffs.length);
  // Blocked is never "clean", even when both sides agree — a value can match and
  // still be malformed, which blocks onboarding just as hard as a missing one.
  const clean = comparisons.filter(
    (cmp) => cmp.billing && !cmp.diffs.length && !blockedSet.has(cmp)
  );

  for (const cmp of clean) {
    const comparable = cmp.rows.filter((r) => !r.informational).length;
    console.log(
      `  ${c.ok("✓")} provider=${cmp.providerId}  ` +
        c.faint(`${comparable}/${comparable} comparable fields match`) +
        (cmp.countryCode ? c.faint(`  [${cmp.countryCode}]`) : "")
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
      `${withDiffs.length ? c.bad(`✗ ${withDiffs.length} differ`) : `✗ 0 differ`}   ` +
      `${blockedSet.size ? c.bad(`⛔ ${blockedSet.size} blocked`) : `⛔ 0 blocked`}` +
      // Not part of the comparison — these providers had nothing to compare. Shown
      // on the same line because this is where you count the run up, and a provider
      // that was silently never checked belongs in that count.
      (missing.length ? `   ${c.bad(`⊘ ${missing.length} no primary legal entity`)}` : "")
  );

  const blocked = [...blockedSet];
  if (blocked.length) {
    console.log(
      c.bad(
        `\n  ⛔ ${blocked.length} provider(s) missing REQUIRED e-invoicing fields on the legal entity:`
      )
    );
    for (const cmp of blocked) {
      console.log(
        `      provider=${cmp.providerId} [${cmp.countryCode}] — ` +
          c.bad(cmp.blocking.map(blockingLabel).join(", ")) +
          (cmp.billing ? "" : c.faint("   (also has no billing row)"))
      );
    }
    console.log(
      c.faint(
        "      Required sets come from app-accounting-documents:\n" +
          "        SA      → EInvoicing.Comarch.LegalEntityBillingDetails @required_fields\n" +
          "        ES / IT → EInvoicing.Common.LegalEntityBillingDetails  @required_fields"
      )
    );
  }

  return {
    clean: clean.length,
    noBilling: noBilling.length,
    differ: withDiffs.length,
    blocked: blocked.length,
  };
}

// The pre-flight verdict. A field difference is a FAIL: the whole point of a
// pre-flight is to say whether the data is fit to proceed on, and two systems
// disagreeing about a legal name or a tax number is precisely what you want to
// know before linking anything.
//
// Missing rows don't decide the verdict here — a provider with no billing info or
// no primary legal entity has nothing to be inconsistent about, so it can't
// contradict anything. It is still reported, and a provider with no primary legal
// entity is reported in RED: it was not checked at all, which is a worse thing to
// overlook than a difference you can see in a table.
//
// The one place that rule flips is a run where NOTHING was comparable — see the
// dead-end block in pre-flight, which fails outright. The asymmetry is deliberate:
// "some providers checked and consistent" is a real pass, while "nothing checked"
// is a pre-flight that never happened. A bulk --all sweep legitimately contains
// plenty of un-migrated providers and must not be permanently red.
function printPreflightVerdict(tally, missing) {
  const failed = tally.differ > 0 || tally.blocked > 0;

  console.log(verdictBanner(failed));

  if (failed) {
    if (tally.blocked) {
      console.log(
        `  ${c.bad("⛔")} ${tally.blocked} provider(s) missing REQUIRED e-invoicing fields — ` +
          "onboarding/send WILL fail for these."
      );
    }
    console.log(
      `  ${c.bad("✗")} ${tally.differ} provider(s) where billing info and the legal entity disagree.`
    );
    console.log(c.faint("    Reconcile those before linking — see the tables above."));
  } else {
    console.log(
      `  ${c.ok("✓")} ${tally.clean} provider(s) checked, every comparable field agrees.`
    );
  }

  if (tally.noBilling) {
    console.log(
      `  ${c.warn("⚠")} ${tally.noBilling} provider(s) skipped — no billing row.` +
        c.faint("  (Nothing to compare — not counted as a failure.)")
    );
  }

  if (missing.length) {
    console.log(
      `  ${c.bad("⊘")} ${missing.length} provider(s) NOT checked at all — no primary ` +
        "legal entity."
    );
    console.log(c.faint("    Nothing to link for those; run migrate first — listed above."));
  }

  console.log(c.faint("\n  Read-only: this mode issues SELECTs and nothing else."));
  return failed;
}

// --- reset (STAGING ONLY) -----------------------------------------------------
//
// Undoes the legal-entities migration for a provider so the task can run again
// from scratch. STAGING ONLY — production is refused outright; this deletes rows
// with no undo.
//
// It clears exactly what the migration writes (RESET_SHEDUL_STEPS, plus the
// plugin link in accounting_documents and a soft-delete of the legal entities),
// leaving `provider_purchases` and friends alone.

// Read-only: how many rows each step would touch, and which legal entities the
// provider currently references.
function fetchResetPreview(env, providerId) {
  const counts = RESET_SHEDUL_STEPS.map(
    (step) =>
      `SELECT '${step.table}' AS t, count(*) AS n FROM ${step.table} ` +
      `WHERE ${step.where.replace("%ID%", providerId)}`
  );
  const ordered = counts
    .map((s, i) => `SELECT ${i} AS ord, t, n FROM (${s}) s${i}`)
    .join("\nUNION ALL\n");

  const shedul = parseRows(
    psqlRead(env, SHEDUL_DB, `SELECT t, n FROM (\n${ordered}\n) all_counts ORDER BY ord;`),
    2
  ).map(([table, n]) => ({ table, count: Number(n) }));

  // Every legal entity this provider points at, from either side — the status
  // rows and the primary pointer, history included.
  const leSql =
    "SELECT DISTINCT legal_entity_id::text FROM (\n" +
    `  SELECT legal_entity_id FROM billing_migration_statuses WHERE provider_id = ${providerId}\n` +
    "  UNION\n" +
    `  SELECT legal_entity_id FROM provider_purchases_primary_legal_entities WHERE provider_id = ${providerId}\n` +
    ") ids WHERE legal_entity_id IS NOT NULL;";

  const legalEntityIds = parseRows(psqlRead(env, SHEDUL_DB, leSql), 1)
    .map(([id]) => id)
    .filter(Boolean);

  // Plugins in the other database that were linked to those entities.
  const pluginSql =
    "SELECT count(*)\n" +
    "FROM account_configuration_plugins p\n" +
    "JOIN account_configurations ac ON ac.id = p.account_configuration_id\n" +
    `WHERE ac.provider_id = ${providerId} AND p.legal_entity_id IS NOT NULL;`;

  const linkedPlugins = Number(
    (parseRows(psqlRead(env, AD_DB, pluginSql), 1)[0] || ["0"])[0]
  );

  return { shedul, legalEntityIds, linkedPlugins };
}

function printResetPreview(providerId, preview, opts) {
  console.log(c.head("\n── Reset plan (read-only preview) ──────────────────────"));

  const rows = RESET_SHEDUL_STEPS.map((step) => {
    const found = preview.shedul.find((s) => s.table === step.table);
    return [
      step.action === "delete" ? c.bad("DELETE") : c.warn("SET NULL"),
      `${SHEDUL_DB}.${step.table}`,
      found ? found.count : "?",
      c.faint(step.note),
    ];
  });

  rows.unshift([
    c.warn("SET NULL"),
    `${AD_DB}.account_configuration_plugins`,
    preview.linkedPlugins,
    c.faint("unlink the plugin(s) from the legal entity"),
  ]);

  if (opts.deleteLegalEntities && preview.legalEntityIds.length) {
    rows.push([
      c.bad("SOFT DELETE"),
      `${LE_DB}.legal_entities`,
      preview.legalEntityIds.length,
      c.faint("set deleted_at — orphaned entities"),
    ]);
  }

  console.log(renderTable(["ACTION", "TABLE", "ROWS", "WHY"], rows));

  if (preview.legalEntityIds.length) {
    console.log(
      `\n  Legal entities referenced by provider=${providerId}:` +
        (opts.deleteLegalEntities ? "" : c.faint("  (kept — --keep-legal-entities)"))
    );
    for (const id of preview.legalEntityIds) console.log(`      ${c.sql(id)}`);
  } else {
    console.log(c.faint("\n  No legal entities referenced — nothing to soft-delete."));
  }

  console.log(
    c.faint(
      `\n  NOT touched: ${RESET_UNTOUCHED.join(", ")}.\n` +
        "  Those carry legal_entity_id but this migration never writes them, and\n" +
        "  provider_purchases are real financial records."
    )
  );

  const total =
    preview.shedul.reduce((n, s) => n + s.count, 0) + preview.linkedPlugins;
  return total;
}

// One transaction for the shedul side. Order matters: billing_migration_statuses
// is last so the migration state only vanishes once nothing references the entity.
function buildResetShedulSql(providerId) {
  const statements = RESET_SHEDUL_STEPS.map((step) => {
    const where = step.where.replace("%ID%", providerId);
    return step.action === "delete"
      ? `DELETE FROM ${step.table} WHERE ${where};`
      : `UPDATE ${step.table} SET ${step.column} = NULL WHERE ${where};`;
  });

  return (
    `-- reset legal-entities migration state for provider_id=${providerId}\n` +
    "BEGIN;\n" +
    statements.join("\n") +
    "\nCOMMIT;\n"
  );
}

function buildResetPluginSql(providerId) {
  return (
    `-- unlink plugins for provider_id=${providerId}\n` +
    "BEGIN;\n" +
    "UPDATE account_configuration_plugins p\n" +
    "SET legal_entity_id = NULL\n" +
    "FROM account_configurations ac\n" +
    `WHERE ac.id = p.account_configuration_id AND ac.provider_id = ${providerId};\n` +
    "COMMIT;\n"
  );
}

// Soft delete, not DELETE: legal_entity_associations / _events / _capabilities /
// _field_versions all hang off these rows, and deleted_at is the service's own
// convention (schemas filter on `where: [deleted_at: nil]`).
function buildResetLegalEntitySql(legalEntityIds) {
  const quoted = legalEntityIds.map((id) => `'${id}'`).join(",");
  return (
    `-- soft-delete orphaned legal entities\n` +
    "BEGIN;\n" +
    `UPDATE legal_entities SET deleted_at = now() WHERE id IN (${quoted}) AND deleted_at IS NULL;\n` +
    "COMMIT;\n"
  );
}

// psql with --write, one file per database. ON_ERROR_STOP + the BEGIN/COMMIT in
// the SQL means a failure rolls that database's changes back.
function psqlWrite(namespace, db, sql, label) {
  const tmp = path.join(os.tmpdir(), `reset_${label}_${process.pid}.sql`);
  fs.writeFileSync(tmp, sql);
  try {
    runInherit("houston", [
      "psql",
      namespace,
      db,
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

// --- KYC status ----------------------------------------------------------------
//
// Mirrors AccountingDocuments.EInvoicing.Common.PaymentsKycGate, which gates
// onboarding on the Billing Profiles path:
//
//   payments not enabled                        -> allow (KYC irrelevant)
//   payments enabled + KYC approved             -> allow
//   payments enabled + not approved/not synced  -> {:error, :kyc_not_approved}
//
// The gate resolves this over three RPCs: Platform get_provider
// (`fresha_pay_enabled`), legal-entities get_legal_entity (which carries the
// adyen-platform legal-entity id when synced), then adyen-platform
// get_legal_entity (`verification_status`).
//
// From psql we can reproduce TWO of the three outcomes exactly:
//   * payments not enabled            -> ALLOWED, definitively
//   * payments enabled + not synced    -> NOT APPROVED, definitively (the gate
//                                        treats "not synced" as not approved)
// The third — payments enabled AND synced — needs the adyen-platform
// verification_status. Its backing table (adyen_platform.legal_entity_verifications)
// is empty in staging, so we report it as UNKNOWN rather than guessing. Never
// claim PASSED from the database.
const ADYEN_DB = "adyen_platform";

// providers.fresha_pay is enum %i[not_set enabled disabled] — see Provider model.
const FRESHA_PAY = { 0: "not_set", 1: "enabled", 2: "disabled" };

function fetchPaymentsEnabled(env, providerIds) {
  const sql =
    "SELECT id::text, coalesce(fresha_pay::text, '')\n" +
    "FROM providers\n" +
    `WHERE id IN (${providerIds.join(",")})\n` +
    "ORDER BY id;";

  const map = new Map();
  for (const [id, freshaPay] of parseRows(psqlRead(env, SHEDUL_DB, sql), 2)) {
    map.set(id, FRESHA_PAY[freshaPay] || (freshaPay === "" ? "not_set" : freshaPay));
  }
  return map;
}

// The Fresha legal entity stores the adyen-platform legal-entity id when synced to
// a KYC provider; that id is the primary key over in adyen_platform.legal_entities.
function fetchKycSync(env, legalEntityIds) {
  if (!legalEntityIds.length) return new Map();
  const quoted = legalEntityIds.map((id) => `'${id}'`).join(",");

  const sql =
    "SELECT id::text, coalesce(adyen_platform_legal_entity_id::text, '')\n" +
    "FROM legal_entities\n" +
    `WHERE id IN (${quoted});`;

  const map = new Map();
  for (const [id, adyenId] of parseRows(psqlRead(env, LE_DB, sql), 2)) {
    map.set(id, adyenId || null);
  }
  return map;
}

// Whatever adyen-platform knows about those entities. legal_entity_verifications is
// the closest thing to the RPC's verification_status; where there is no row we say
// so rather than inferring approval.
function fetchAdyenVerifications(env, adyenLegalEntityIds) {
  if (!adyenLegalEntityIds.length) return new Map();
  const quoted = adyenLegalEntityIds.map((id) => `'${id}'`).join(",");

  const sql =
    "SELECT le.id::text, coalesce(le.tier::text, ''), coalesce(le.adyen_legal_entity_id, ''),\n" +
    "       coalesce((SELECT v.state::text FROM legal_entity_verifications v\n" +
    "                 WHERE v.legal_entity_id = le.id ORDER BY v.updated_at DESC LIMIT 1), '')\n" +
    "FROM legal_entities le\n" +
    `WHERE le.id IN (${quoted});`;

  const map = new Map();
  for (const row of parseRows(psqlRead(env, ADYEN_DB, sql), 4)) {
    const [id, tier, adyenId, state] = row;
    map.set(id, { tier, adyenId: adyenId || null, state: state || null });
  }
  return map;
}

// The gate's verdict, as far as the database can honestly establish it.
function kycVerdict({ payments, adyenLegalEntityId, adyen }) {
  if (payments !== "enabled") {
    return {
      state: "allowed",
      text: `payments ${payments} — KYC not required`,
      exact: true,
    };
  }
  if (!adyenLegalEntityId) {
    return {
      state: "not_approved",
      text: "payments enabled but not synced to a KYC provider — gate returns kyc_not_approved",
      exact: true,
    };
  }
  if (adyen && adyen.state === "success") {
    return { state: "likely_approved", text: "adyen verification: success", exact: false };
  }
  if (adyen && adyen.state) {
    return { state: "not_approved", text: `adyen verification: ${adyen.state}`, exact: false };
  }
  return {
    state: "unknown",
    text: "payments enabled and synced, but no verification record — needs the adyen-platform RPC",
    exact: false,
  };
}

function printKycStatus(rows) {
  const mark = {
    allowed: c.ok("✓ allowed"),
    likely_approved: c.ok("✓ likely"),
    not_approved: c.bad("✗ not approved"),
    unknown: c.warn("? unknown"),
  };

  console.log(c.head("\n── KYC / payments gate ─────────────────────────────────"));
  console.log(
    renderTable(
      ["PROVIDER", "PAYMENTS", "KYC PROVIDER (adyen LE)", "TIER", "GATE", "BASIS"],
      rows.map((r) => [
        r.providerId,
        r.payments,
        r.adyenLegalEntityId || c.faint("∅ not synced"),
        (r.adyen && r.adyen.tier) || "—",
        mark[r.verdict.state] || r.verdict.state,
        r.verdict.exact ? r.verdict.text : c.faint(r.verdict.text),
      ])
    )
  );

  const blocked = rows.filter((r) => r.verdict.state === "not_approved");
  const unknown = rows.filter((r) => r.verdict.state === "unknown");

  console.log(
    c.faint(
      "\n  Mirrors EInvoicing.Common.PaymentsKycGate. Payments come from providers.fresha_pay\n" +
        "  (enum not_set/enabled/disabled); the KYC-provider link is\n" +
        "  legal_entities.adyen_platform_legal_entity_id. The gate treats NOT SYNCED as not\n" +
        "  approved, so those two verdicts are exact."
    )
  );
  if (unknown.length) {
    console.log(
      c.warn(
        `\n  ? ${unknown.length} provider(s) UNKNOWN: payments enabled and synced, but the\n` +
          "    authoritative verification_status lives behind the adyen-platform RPC.\n" +
          `    ${ADYEN_DB}.legal_entity_verifications has no row for them — this script will\n` +
          "    not claim PASSED from the database."
      )
    );
  }
  if (blocked.length) {
    console.log(
      c.bad(
        `\n  ✗ ${blocked.length} provider(s) would be blocked by the KYC gate: ` +
          blocked.map((r) => r.providerId).join(", ")
      )
    );
  }

  return blocked.length;
}

// --- plugin audit -------------------------------------------------------------
//
// Pre-flight compares billing info against the provider's PRIMARY legal entity.
// This compares it against the legal entity each PLUGIN actually points at, which
// is what the send path reads: BillingDetailsPolicy resolves the plugin, then uses
// `plugin.legal_entity_id`. The two answers differ exactly when a plugin has
// drifted off the primary — and it's the plugin's copy that decides whether an
// invoice can be issued.
//
// One section per plugin row, because a provider can hold several and each carries
// its own legal_entity_id.

// Providers that actually have a plugin — a provider can have an
// account_configuration with no plugin, in which case there is nothing to audit.
function fetchProviderIdsWithPlugins(env) {
  const sql =
    "SELECT DISTINCT ac.provider_id\n" +
    "FROM account_configuration_plugins p\n" +
    "JOIN account_configurations ac ON ac.id = p.account_configuration_id\n" +
    "WHERE ac.provider_id IS NOT NULL\n" +
    "ORDER BY ac.provider_id;";

  return parseRows(psqlRead(env, AD_DB, sql), 1)
    .map(([id]) => id)
    .filter((id) => /^\d+$/.test(id));
}

// Build one comparison per plugin. `primary` is carried only to flag divergence —
// the comparison itself is against the plugin's own legal entity.
function comparePlugins(pluginsByProvider, billing, leFields, countries, primaryByProvider) {
  const out = [];

  for (const [providerId, plugins] of [...pluginsByProvider.entries()].sort(
    (a, b) => Number(a[0]) - Number(b[0])
  )) {
    for (const plugin of plugins) {
      const primary = primaryByProvider.get(providerId) || null;

      if (!plugin.legalEntityId) {
        // Nothing to compare against — the plugin isn't linked yet.
        out.push({
          providerId,
          plugin,
          unlinked: true,
          primary,
          rows: [],
          diffs: [],
          blocking: [],
          countryCode: countries.get(providerId) || "",
        });
        continue;
      }

      const cmp = compareFields(
        providerId,
        billing.get(providerId),
        leFields.get(plugin.legalEntityId),
        countries.get(providerId)
      );

      out.push({
        ...cmp,
        plugin,
        unlinked: false,
        primary,
        // The plugin points somewhere other than the provider's primary. Not
        // wrong by itself, but it means pre-flight and this mode are looking at
        // different entities.
        diverged: Boolean(primary && primary !== plugin.legalEntityId),
      });
    }
  }

  return out;
}

function printPluginAudit(opts, audits, detail) {
  const linked = audits.filter((a) => !a.unlinked);
  const unlinked = audits.filter((a) => a.unlinked);
  const blocked = linked.filter((a) => a.blocking.length);
  const diverged = linked.filter((a) => a.diverged);
  const clean = linked.filter((a) => !a.blocking.length && !a.diffs.length);

  console.log(c.head("\n── Plugin audit — billing info vs the plugin's legal entity ──"));
  console.log(
    renderTable(
      ["", "PROVIDER", "PLUGIN", "TYPE", "STATUS", "PLUGIN'S LEGAL ENTITY", "RESULT"],
      audits.map((a) => {
        const mark = a.unlinked
          ? c.faint("–")
          : a.blocking.length
            ? c.bad("✗")
            : a.diffs.length
              ? c.bad("✗")
              : c.ok("✓");
        const comparable = a.rows.filter((r) => !r.informational).length;
        const matched = a.rows.filter((r) => !r.informational && r.same && !r.blocking).length;
        return [
          mark,
          a.providerId,
          a.plugin.id,
          a.plugin.pluginType,
          a.plugin.pluginStatus,
          a.unlinked ? c.faint("∅ not linked") : a.plugin.legalEntityId,
          a.unlinked
            ? c.faint("nothing to compare — run link first")
            : `${matched}/${comparable} agree` +
              (a.blocking.length ? c.bad(`  ⛔ ${a.blocking.length} unusable`) : "") +
              (a.diverged ? c.warn("  ⚠ not the primary") : ""),
        ];
      })
    )
  );

  if (detail) {
    for (const a of linked) {
      printProviderFieldTable(
        a,
        `plugin=${a.plugin.id} (provider=${a.providerId}, ${a.plugin.pluginType}, ` +
          `${a.entityType || "unknown"}, ${a.countryCode || "?"})`
      );
      if (a.diverged) {
        console.log(
          c.warn(
            `  ⚠ this plugin points at ${a.plugin.legalEntityId}, but the provider's\n` +
              `     primary is ${a.primary} — pre-flight compares the primary, this compares the plugin.`
          )
        );
      }
    }
  }

  if (blocked.length) {
    console.log(c.bad("\n  ⛔ Plugins whose legal entity can't support e-invoicing:"));
    for (const a of blocked) {
      console.log(
        `      plugin=${a.plugin.id} provider=${a.providerId} [${a.countryCode}] — ` +
          c.bad(a.blocking.map(blockingLabel).join(", "))
      );
    }
  }

  if (diverged.length) {
    console.log(
      c.warn(`\n  ⚠ ${diverged.length} plugin(s) not pointing at their provider's primary:`)
    );
    for (const a of diverged) {
      console.log(`      plugin=${a.plugin.id} provider=${a.providerId}`);
      console.log(c.faint(`        plugin  ${a.plugin.legalEntityId}`));
      console.log(c.faint(`        primary ${a.primary}`));
    }
  }

  console.log(
    `\n  ${c.ok(`✓ ${clean.length} consistent`)}   ` +
      `${c.faint(`– ${unlinked.length} not linked`)}   ` +
      `${blocked.length ? c.bad(`⛔ ${blocked.length} blocked`) : "⛔ 0 blocked"}   ` +
      `${diverged.length ? c.warn(`⚠ ${diverged.length} diverged`) : "⚠ 0 diverged"}`
  );

  const failed = blocked.length > 0 || linked.some((a) => a.diffs.length);
  console.log(
    failed
      ? c.bad("\n══ PLUGIN AUDIT: FAIL ══════════════════════════════════")
      : c.ok("\n══ PLUGIN AUDIT: PASS ══════════════════════════════════")
  );
  console.log(
    failed
      ? `  ${c.bad("✗")} the legal entity behind at least one plugin does not match billing info.`
      : `  ${c.ok("✓")} every linked plugin's legal entity agrees with billing info.`
  );
  console.log(
    c.faint(
      "\n  Read-only: SELECTs only. This compares the PLUGIN's legal_entity_id — what\n" +
        "  the send path reads. Pre-flight compares the provider's primary instead."
    )
  );

  return failed;
}

// --- markdown export ----------------------------------------------------------
//
// Built from the comparison objects, never from the rendered terminal output: that
// carries ANSI escapes when stdout is a TTY, and its column padding is meaningless
// in Markdown. No c.* helper may appear anywhere in this section.

// A value can legitimately contain a pipe (a street, a legal name) — the same
// reason parseRowsLoose exists. Escape it or the table silently gains a column.
function mdCell(value, emptyAs = "—") {
  return String(value === null || value === undefined || value === "" ? emptyAs : value)
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function mdTable(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    // Explicit arrow: Array#map would pass the index as mdCell's `emptyAs`.
    ...rows.map((r) => `| ${r.map((cell) => mdCell(cell)).join(" | ")} |`),
  ].join("\n");
}

// How a blocking row blocks — "missing" and "present but malformed" are different
// problems and want different fixes, so never collapse them into one word.
function blockingLabel(row) {
  return row.leBadFormat ? `${row.label} (invalid format)` : `${row.label} (missing)`;
}

// Plain-text equivalents of the terminal symbols.
function mdPresence(row) {
  if (row.leBadFormat) return "⛔ **invalid format**";
  if (row.blocking) return "⛔ **blocks e-invoicing**";
  if (row.informational) return "provider only *(no LE counterpart)*";
  if (row.same) return "✅ both";
  if (row.presence === "both") return "❌ differs";
  if (row.presence === "neither") return "❌ neither";
  return `⚠ ${row.presence}`;
}

function buildPreflightMarkdown(
  opts,
  comparisons,
  tally,
  missing,
  detail,
  title,
  kycRows
) {
  const blocked = comparisons.filter((cmp) => cmp.blocking.length);
  const failed = tally.differ > 0 || tally.blocked > 0;
  const out = [];

  out.push(`# ${title || "Pre-flight — provider billing informations vs legal entities"}`);
  out.push("");
  out.push(
    mdTable(
      ["", ""],
      [
        ["namespace", opts.namespace],
        ["generated", new Date().toISOString()],
        ["providers compared", comparisons.length],
        [
          "verdict",
          `**${failed ? "FAIL" : "PASS"}** — ${tally.blocked} blocked, ` +
            `${tally.differ} differ, ${tally.clean} consistent` +
            (missing.length ? `, ${missing.length} not checked` : ""),
        ],
      ]
    )
  );

  // Blocked first: it's the part someone has to act on.
  out.push("");
  out.push("## Blocked — required fields unusable in the legal entity");
  out.push("");
  if (blocked.length) {
    out.push(
      mdTable(
        ["Provider", "Country", "Entity type", "Problem fields"],
        blocked.map((cmp) => [
          cmp.providerId,
          cmp.countryCode,
          cmp.entityType,
          cmp.blocking.map(blockingLabel).join(", "),
        ])
      )
    );
    out.push("");
    out.push(
      "These providers will fail e-invoicing onboarding/send until the legal entity " +
        "carries the fields above. `(missing)` means absent — " +
        "`{:error, :missing_required_fields}`. `(invalid format)` means present but " +
        "in a shape `ValidationHelpers` rejects."
    );
  } else {
    out.push("None — every provider carries the fields its country requires.");
  }

  // Only when there is something to report — the plugin audit passes [] here, and
  // an empty section would read as a claim that every provider was checked.
  if (missing.length) {
    out.push("");
    out.push("## Not checked — no active primary legal entity");
    out.push("");
    out.push(
      mdTable(
        ["Provider", "Billing details", "Fix"],
        missing.map(({ providerId, hasBilling }) => [
          providerId,
          hasBilling ? "present" : "**none**",
          hasBilling
            ? "migrate has not run yet — run it, then re-run pre-flight"
            : "migrate has nothing to build an entity from — add billing details first",
        ])
      )
    );
    out.push("");
    out.push(
      "These providers were compared against nothing. No row with `valid_to IS NULL` " +
        "in `provider_purchases_primary_legal_entities`, so there is no entity to " +
        "check and nothing for `link` to link."
    );
  }

  if (detail) {
    for (const cmp of comparisons) {
      const comparable = cmp.rows.filter((r) => !r.informational);
      // A row where BOTH sides are empty is "equal" but still blocking — agreement on
  // nothing is not agreement, so it must not inflate the count.
  const matched = comparable.filter((r) => r.same && !r.blocking).length;

      out.push("");
      out.push(`## provider=${cmp.providerId} (${cmp.entityType || "unknown"}, ${cmp.countryCode || "?"})`);
      out.push("");
      out.push(
        `${matched}/${comparable.length} comparable fields agree` +
          (cmp.required ? "" : " *(not an e-invoicing country — nothing required)*") +
          "."
      );
      out.push("");
      out.push(
        mdTable(
          ["Field", "Required?", "Provider billing (shedul)", "Legal entity (`fields` jsonb)", "Present?"],
          cmp.rows.map((r) => [
            r.label,
            // Blank, not a dash: an unmarked row simply isn't required.
            r.required ? "**yes**" : " ",
            r.pbi,
            r.le ? `\`${r.leKey}\` = ${r.le}` : r.leKey ? `\`${r.leKey}\` = ∅` : "—",
            mdPresence(r),
          ])
        )
      );
    }
  }

  if (kycRows && kycRows.length) {
    out.push("");
    out.push("## KYC / payments gate");
    out.push("");
    out.push(
      mdTable(
        ["Provider", "Payments", "KYC provider (adyen LE)", "Tier", "Gate", "Basis"],
        kycRows.map((r) => [
          r.providerId,
          r.payments,
          r.adyenLegalEntityId || "∅ not synced",
          (r.adyen && r.adyen.tier) || "—",
          { allowed: "✓ allowed", likely_approved: "✓ likely", not_approved: "✗ not approved", unknown: "? unknown" }[
            r.verdict.state
          ] || r.verdict.state,
          r.verdict.exact ? r.verdict.text : `*${r.verdict.text}*`,
        ])
      )
    );
    out.push("");
    out.push(
      "Mirrors `AccountingDocuments.EInvoicing.Common.PaymentsKycGate`: payments not " +
        "enabled → allowed (KYC irrelevant); payments enabled + approved → allowed; " +
        "payments enabled + not approved **or not synced** → `{:error, :kyc_not_approved}`."
    );
    out.push("");
    out.push(
      "| Signal | Source | Exact? |\n|---|---|---|\n" +
        "| payments enabled | `shedul.providers.fresha_pay` (enum `not_set`/`enabled`/`disabled`) | yes |\n" +
        "| synced to KYC provider | `legal_entities.adyen_platform_legal_entity_id` | yes |\n" +
        `| verification status | \`${ADYEN_DB}.legal_entity_verifications.state\` | **no** — authoritative value is behind the adyen-platform RPC |`
    );
    out.push("");
    out.push(
      "Rows in *italics* are inferred, not definitive. **`? unknown` means payments are " +
        "enabled and the entity is synced, but no verification record exists — this report " +
        "will not claim PASSED from the database.**"
    );
  }

  out.push("");
  out.push('## Where "required" comes from');
  out.push("");
  out.push(
    "Both validators fetch the legal entity via `GetLegalEntityInvoiceDetails` and " +
      "hard-fail with `{:error, :missing_required_fields}`:"
  );
  out.push("");
  out.push(
    mdTable(
      ["Field", "ES / IT", "KSA (SA)"],
      [
        ["`company_name`", "required", "not checked — taken from the request"],
        ["`address` (street), `city`, `postal_code`, `state_province`", "required", "required"],
        ["`tax_number`", "required — `TAX_IDENTIFICATION_NUMBER`", "required — `TAX_NUMBER` (ZATCA TRN)"],
        ["`company_registration_number`", "—", "**required**"],
        ["`building_number`, `district`", "—", "**required**"],
        ["`country_code`", "not checked", "not checked"],
      ]
    )
  );
  out.push("");
  out.push(
    "- `SA` → `AccountingDocuments.EInvoicing.Comarch.LegalEntityBillingDetails` `@required_fields`\n" +
      "- `ES` / `IT` → `AccountingDocuments.EInvoicing.Common.LegalEntityBillingDetails` `@required_fields`\n" +
      "\n" +
      "The country comes from `account_configurations.country_code` — that's what " +
      "`BillingDetailsPolicy` dispatches on. Countries with no entry have no required set.\n" +
      "\n" +
      "The KSA `tax_number` is a *different identifier kind*, so present-and-equal here " +
      "is necessary but not sufficient."
  );

  out.push("");
  out.push("### KSA format rules");
  out.push("");
  out.push(
    "Presence is not the only bar — `AccountingDocuments.Helpers.ValidationHelpers` " +
      "also enforces shape, so a present-but-malformed value still fails:"
  );
  out.push("");
  out.push(
    mdTable(
      ["Field", "Rule", "Source"],
      [
        ["`company_registration_number`", "exactly 10 characters", "`valid_ksa_crn?`"],
        [
          "`tax_number`",
          "15 digits, starts `3`, ends `03` — `~r/^3\\d{12}03$/`",
          "`valid_ksa_tax_id?`",
        ],
      ]
    )
  );

  out.push("");
  out.push(
    `<sub>Generated by \`plugin_legal_entity_updates.js --preflight\` — read-only.</sub>`
  );
  out.push("");

  return out.join("\n");
}

// Resolve the export path: --md with a value uses it, --md alone defaults to a
// dated name in the working directory.
function preflightMarkdownPath(opts) {
  // --md PATH wins; --md on its own gets the dated default.
  if (opts.mdPath) return path.resolve(opts.mdPath);
  const day = new Date().toISOString().slice(0, 10);
  return path.resolve(`preflight-${opts.namespace}-${day}.md`);
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
// Guided first and default — it's the one that explains itself, so it's the right
// landing place for anyone who doesn't already know the order. The rest follow the
// actual workflow (migrate → pre-flight → link → post-flight), each tagged with the
// stage it belongs to, so the menu teaches the procedure rather than listing verbs.
async function askMode() {
  return askChoice("What do you want to do?", [
    {
      section: "MIGRATION — the procedure, in order",
      label: "Guided       — the whole procedure, step by step",
      stage: "start here",
      detail:
        "walks pre-flight → link → post-flight, explaining each step before you run it. " +
        "Migrate and reset are described but not run.",
      aliases: ["guided", "guide", "walkthrough", "steps", "all"],
      value: "guided",
      default: true,
    },
    {
      label: "Migrate      — create the legal entities",
      stage: "stage 1 · writes",
      detail:
        `runs ${MIGRATE_TASK} on ${MIGRATE_SERVICE}. Do this first — ` +
        "nothing else works without an entity. No dry run.",
      aliases: ["migrate", "migration", "create"],
      value: "migrate",
    },
    {
      label: "Pre-flight   — is the data fit to link?",
      stage: "stage 2 · read-only",
      detail:
        "billing info vs the provider's PRIMARY legal entity, plus the per-country " +
        "required fields and KSA formats. PASS/FAIL.",
      aliases: ["pre", "preflight", "pre-flight", "check", "data"],
      value: "preflight",
    },
    {
      label: "Link         — point the plugins at the legal entity",
      stage: "stage 3 · writes",
      detail:
        `runs ${TASK}. Dry run by default; ` +
        "reads the rows back afterwards to prove what landed.",
      aliases: ["link", "apply", "run", "fix"],
      value: "link",
    },
    {
      label: "Post-flight  — did the link actually land?",
      stage: "stage 4 · read-only",
      detail:
        "each plugin's legal_entity_id vs its provider's primary. The task exits 0 " +
        "even when it skips rows, so only this proves it. PASS/FAIL.",
      aliases: ["post", "postflight", "post-flight", "verify"],
      value: "postflight",
    },
    {
      section: "REPORTING — look, don't touch",
      label: "Plugin audit — billing info vs each PLUGIN's legal entity",
      stage: "any stage · read-only",
      detail:
        "what the send path actually reads (plugin.legal_entity_id, not the primary). " +
        "One section per plugin.",
      aliases: ["plugins", "plugin", "audit", "by-plugin"],
      value: "plugins",
    },
    {
      section: "STAGING ONLY — destructive",
      label: "Reset        — undo the migration for a provider",
      stage: "remedial · STAGING ONLY · destructive",
      detail:
        "clears migration state, the primary pointer and the plugin link so migrate " +
        "can genuinely re-run. No undo.",
      aliases: ["reset", "undo", "clear", "wipe"],
      value: "reset",
    },
  ]);
}

// Guided walks a specific set of providers through the whole sequence, so it takes
// an explicit list — the migrate step it runs would refuse anything else.
async function askGuidedProviderIds() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await ask("\nProvider IDs to walk through (comma- or space-separated): ");
    try {
      return parseProviderIds(raw);
    } catch (err) {
      console.error(`  ${err.message}`);
    }
  }
  throw new Error("No valid provider IDs given.");
}

// MIGRATE_PAYMENT_METHODS has an external side effect — it migrates cards on file
// through an RPC — so it is asked rather than assumed, even though true is the
// usual answer.
async function askMigratePaymentMethods() {
  return askChoice("Migrate payment methods too?", [
    {
      label: 'yes — MIGRATE_PAYMENT_METHODS="true"',
      detail: "also migrates cards on file via an RPC. This is how the task is normally run.",
      aliases: ["yes", "y", "true"],
      value: true,
      default: true,
    },
    {
      label: 'no — MIGRATE_PAYMENT_METHODS="false"',
      detail: "creates the legal entity only; leaves cards on file alone.",
      aliases: ["no", "n", "false"],
      value: false,
    },
  ]);
}

// Whether to soft-delete the entities a reset orphans. Leaving them live is what
// produced provider 33's duplicates, so yes is the default.
async function askDeleteLegalEntities() {
  return askChoice("Soft-delete the orphaned legal entities?", [
    {
      label: "yes — set deleted_at on them",
      detail: "leaving them live is what leaves duplicate entities behind.",
      aliases: ["yes", "y"],
      value: true,
      default: true,
    },
    {
      label: "no — leave the entities alone",
      detail: "clears the migration state only; the entities stay live but unreferenced.",
      aliases: ["no", "n", "keep"],
      value: false,
    },
  ]);
}

// Reset takes an explicit list too — and, being destructive, no "all" option.
async function askResetProviderIds() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await ask("\nProvider IDs to RESET (comma- or space-separated): ");
    try {
      return parseProviderIds(raw);
    } catch (err) {
      console.error(`  ${err.message}`);
    }
  }
  throw new Error("No valid provider IDs given.");
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
  const chooseAll = await askChoice("Which providers?", [
    {
      label: `every provider with an account configuration (${AD_DB})`,
      aliases: ["all", "every"],
      value: true,
      default: true,
    },
    { label: "a list I'll type", aliases: ["list", "some", "specific"], value: false },
  ]);

  if (chooseAll) {
    console.log(c.faint(`\nFinding providers in ${AD_DB}.account_configurations (read-only)…`));
    const ids = fetchAllProviderIds(env);
    if (!ids.length) throw new Error("No providers found in account_configurations.");
    console.log(`Found ${ids.length} provider(s) with an account configuration.`);
    // Reporting the choice back drives the detail-vs-summary default: a bulk
    // sweep gets one line per provider, a named set gets the full field tables.
    return { ids, all: true };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await ask("  provider IDs (comma- or space-separated): ");
    try {
      // Same {ids, all} shape as the "all" branch above — the caller needs to know
      // which was chosen so detail-vs-summary defaults correctly.
      return { ids: parseProviderIds(raw), all: false };
    } catch (err) {
      console.error(`  ${err.message}`);
    }
  }
  throw new Error("No valid provider IDs given.");
}

// Approval for a WRITE must come from a human at a keyboard. A "yes" arriving
// down a pipe is an automated approval, which is exactly what these gates exist
// to prevent, so no flag can supply one — --yes is not --force.
//
// What --yes does buy is the read-only half of the script. Pre-flight,
// post-flight and the plugin audit issue SELECTs and cannot write under any
// combination of flags; link with a dry run runs the task with DRY_RUN=true.
// Refusing those without a TTY bought no safety and made the script unusable by
// anything except a person, which is why they now have a door.
//
// The boundary is deliberately drawn at "can this mode write?", not at "is this
// production?": a read-only mode is safe in prod, and a write is not safe in
// staging just because it is staging.
const READ_ONLY_MODES = new Set(["preflight", "postflight", "plugins"]);

function writesAnything(opts) {
  if (READ_ONLY_MODES.has(opts.mode)) return false;
  // Link only writes on an apply. Guided is treated as writing: it is a
  // run/skip/stop walkthrough that spawns link, so it needs a human regardless.
  if (opts.mode === "link") return opts.apply;
  return true;
}

function requireInteractive(opts) {
  if (input.isTTY) return;

  if (opts.yes && !writesAnything(opts)) return;

  const why = !opts.yes
    ? "stdin is not a TTY, so approval could only come from a pipe or a script —\n" +
      '  and a piped "yes" is not explicit approval.'
    : opts.mode === "guided"
      ? // Guided runs nothing itself, so this is not about writing: it is a
        // run/skip/stop walkthrough, which needs someone to do the choosing.
        "guided is a walkthrough — it asks at every step which is why it needs a\n" +
        "  terminal. Run its steps directly instead: --preflight, then --link, then --postflight."
      : `--yes covers read-only modes only, and "${opts.mode}"` +
        (opts.mode === "link" ? " with --apply writes." : " writes.");

  const what =
    opts.mode === "guided" ? "run guided" : writesAnything(opts) ? "write" : "touch real data";

  throw new UsageError(
    `Refusing to ${what} without an interactive terminal.\n` +
      `  ${why}\n` +
      "  Run it from a terminal, or use a read-only mode with --yes:\n" +
      "    --preflight / --postflight / --plugins / --link --dry-run\n" +
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
  say(`  databases : ${[SHEDUL_DB, AD_DB, LE_DB, ADYEN_DB].join(", ")}`);
  say("  access    : read-only SELECTs — no writes at this stage");

  // --yes IS the approval for reads. The target is still printed above, so an
  // unattended run leaves the same record of what it touched; it just doesn't
  // stop to be told what it was already told on the command line.
  if (opts.yes) {
    say("  approved  : --yes (non-interactive)");
    return true;
  }

  // Same numbered menu as every other decision in the script: "1" confirms, and
  // "yes"/"y" still work for anyone with the muscle memory. The prod/non-prod
  // asymmetry lives in the DEFAULT — in production a bare Enter cancels, so it
  // still takes a deliberate keystroke to read real production data.
  return askChoice("Read from these databases?", [
    { label: "Yes — run the reads", aliases: ["yes", "y", "read"], value: true, default: !prod },
    {
      label: "Cancel — nothing is read",
      aliases: ["no", "n", "cancel", "abort"],
      value: false,
      default: prod,
    },
  ]);
}

// Confirmation gate for the write. Non-prod takes a single "yes"/"y"; production
// makes you type the namespace back first and then requires an exact "yes".
//
// --yes is NOT accepted here, by design. requireInteractive() should already have
// refused any write without a TTY, so this is the backstop: if a future change
// ever lets a write reach this point unattended, it fails loudly instead of
// approving itself.
async function confirmRun(opts) {
  const prod = isProd(opts.namespace);

  if (!input.isTTY) {
    // A dry run writes nothing — DRY_RUN=true only logs — so --yes can approve it.
    // An apply cannot be approved by a flag, ever, in any namespace.
    if (opts.yes && !opts.apply) return true;

    throw new UsageError(
      "Refusing to confirm a write without an interactive terminal.\n" +
        "  --yes approves reads and dry runs, never an apply. Run this from a terminal."
    );
  }

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

// --- guided walkthrough -------------------------------------------------------
//
// The migration procedure written down: what each step is, why it exists, and in
// what order. Runs each step as a SEPARATE INVOCATION of this script rather than
// sharing state with the other modes — so guided adds no coupling to them, and
// every step keeps its own gates (including re-approving its own data access,
// which is the point: each step reads a different thing).
//
// The sequence is verify → link → verify. Order is not arbitrary: pre-flight can
// only compare once a legal entity exists, and post-flight can only confirm a link
// that link made.
//
// MIGRATE is a PRECONDITION of the walkthrough, not a step in it — it writes on the
// first call with no dry run. It's described in the plan (GUIDED_ASIDES) so the
// procedure is complete, but never offered for running here.

const WORKFLOW_STEPS = [
  {
    key: "preflight",
    title: "PRE-FLIGHT — is the data fit to proceed on?",
    writes: false,
    what:
      "Cross-checks provider_billing_informations (shedul) against the legal entity's jsonb fields (legal_entities), field by field, and applies the per-country REQUIRED set that app-accounting-documents enforces (SA via Comarch, ES/IT via Common).",
    why:
      "A required field missing on the legal-entity side makes onboarding/send fail with {:error, :missing_required_fields}. Cheaper to find here than after linking.",
    watch:
      "FAIL here means STOP. Linking a provider whose legal entity is incomplete just moves the failure downstream.",
  },
  {
    key: "link",
    title: "LINK — point the plugins at the legal entity",
    writes: true,
    what:
      "Resolves each provider's primary legal entity and its NULL-legal_entity_id plugin, then runs link_plugins_to_legal_entities_from_env to set it.",
    why:
      "The plugin is what the send path reads. Until it carries the legal_entity_id, e-invoicing still uses the legacy provider billing.",
    watch:
      "This step ASKS: dry run (default) or apply. Choosing apply writes, so guided can complete the migration. Only one plugin can hold a given legal entity.",
  },
  {
    key: "postflight",
    title: "POST-FLIGHT — did it actually land?",
    writes: false,
    what:
      "Compares each plugin's legal_entity_id against its provider's primary and reports PASS/FAIL.",
    why:
      "The link task exits 0 even when it skips every row, so its exit code is not evidence. Only reading the rows back is.",
    watch: "Drift here means the link did not take — check for a unique-index collision.",
  },
];

// Described in the plan so the whole procedure is written down, but never run by
// the walkthrough. Migrate is deliberately excluded: it is the only step that
// writes on the first call with no dry run, and with MIGRATE_PAYMENT_METHODS=true
// it also migrates cards on file through an RPC. One keystroke away from a default
// "Run it" is the wrong place for that — run it on its own, on purpose.
const GUIDED_ASIDES = [
  {
    key: "migrate",
    role: "PREREQUISITE — run separately, before this walkthrough",
    title: "MIGRATE — create the legal entities",
    what:
      "Runs legal_entities_migration:migrate on partners-app. Per provider it classifies (billing_only / adyen_fresha_pay / checkout_fresha_pay), creates the legal entity from provider_billing_informations, assigns locations, and sets it as the provider's primary.",
    why:
      "This walkthrough assumes it has already happened — there has to be an entity to compare against and a primary pointer to link to. If it hasn't, pre-flight will tell you so: 'no active primary legal entity'.",
    watch:
      "Excluded from the sequence on purpose: NO dry run, it writes on the first call, and MIGRATE_PAYMENT_METHODS=true migrates cards via an RPC. Run it with `--migrate` when you mean to.",
  },
  {
    key: "reset",
    role: "REMEDIAL — staging only, destructive",
    title: "RESET — undo the migration so it can be re-run",
    what:
      "Clears the plugin link, primary pointer, location assignments and migration state, and soft-deletes the legal entities.",
    why:
      "The migration is resumable, so an already-migrated provider is never rebuilt. Clearing that state is the only way to force a genuine re-run.",
    watch:
      "A reset only helps if re-running produces something better — it will not if the migrator itself is dropping fields. Verify with pre-flight first.",
  },
];

// Reflow a definition to the terminal, with continuation lines aligned under the
// first — the step text is stored unwrapped so it can be laid out for whichever
// label prefix it appears under.
function wrapText(text, label, indent) {
  const pad = " ".repeat(indent);
  const prefix = `${pad}${label}`;
  const width = Math.max(40, (output.columns || 100) - prefix.length - 1);
  const cont = " ".repeat(prefix.length);

  const lines = [];
  let line = "";
  for (const word of String(text).split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);

  return lines.map((l, i) => (i === 0 ? `${prefix}${l}` : `${cont}${l}`)).join("\n");
}

function printGuidedPlan(opts, providerIds) {
  console.log(c.head("\n══ The Billing Profiles migration, step by step ═════════"));
  console.log(
    `  namespace : ${opts.namespace}${isProd(opts.namespace) ? c.bad("   ⚠ PRODUCTION") : ""}`
  );
  console.log(`  providers : ${providerIds.length} — ${providerIds.join(", ")}`);

  WORKFLOW_STEPS.forEach((step, i) => {
    console.log(
      `\n  ${c.head(`${i + 1}. ${step.title}`)}` +
        (step.writes ? c.warn("   [writes]") : c.faint("   [read-only]"))
    );
    console.log(wrapText(step.what, "what:  ", 5));
    console.log(wrapText(step.why, "why:   ", 5));
    console.log(c.warn(wrapText(step.watch, "watch: ", 5)));
  });

  console.log(c.faint("\n  ── Not run by this walkthrough ─────────────────────────"));
  for (const aside of GUIDED_ASIDES) {
    console.log(`\n  ${c.warn(aside.role)}`);
    console.log(`  ${c.head(aside.title)}`);
    console.log(wrapText(aside.what, "what:  ", 5));
    console.log(wrapText(aside.why, "why:   ", 5));
    console.log(c.warn(wrapText(aside.watch, "watch: ", 5)));
  }

  console.log(
    c.faint(
      "\n  Each step runs as its own invocation of this script, so it keeps its own\n" +
        "  gates and re-approves its own data access. Nothing is shared between them."
    )
  );
}

// Spawn one step. Inherits the terminal so the step's own prompts and Houston's
// output work exactly as they do when run directly.
function runGuidedStep(step, opts, providerIds) {
  const args = [process.argv[1]];
  const env = {
    ...process.env,
    PLE_STEP: step.key,
    PLE_NAMESPACE: opts.namespace,
    PLE_PROVIDERS: providerIds.join(","),
  };

  closeRl();
  console.log(
    `\n${c.faint(`PLE_STEP=${step.key} PLE_NAMESPACE=${opts.namespace} ` +
      `PLE_PROVIDERS=${providerIds.join(",")}`)}\n` +
      `$ ${process.argv[0]} ${args.join(" ")}\n`
  );
  const res = spawnSync(process.argv[0], args, { stdio: "inherit", env });
  if (res.error) throw res.error;
  return res.status === 0;
}

async function runGuided(opts, providerIds) {
  printGuidedPlan(opts, providerIds);

  const results = [];

  for (const [i, step] of WORKFLOW_STEPS.entries()) {
    console.log(c.head(`\n── Step ${i + 1}/${WORKFLOW_STEPS.length}: ${step.title} ─────────`));
    console.log(wrapText(step.what, "", 2));
    console.log(c.warn(wrapText(step.watch, "watch: ", 2)));

    const choice = await askChoice(`Step ${i + 1}: ${step.key}`, [
      { label: `Run it`, aliases: ["run", "yes", "y"], value: "run", default: true },
      { label: "Skip this step", aliases: ["skip", "s"], value: "skip" },
      { label: "Stop the walkthrough", aliases: ["stop", "quit", "q"], value: "stop" },
    ]);

    if (choice === "stop") {
      console.log(c.faint("\nStopped. Nothing further was run."));
      break;
    }
    if (choice === "skip") {
      results.push({ step, outcome: "skipped" });
      console.log(c.faint(`  Skipped ${step.key}.`));
      continue;
    }

    const ok = runGuidedStep(step, opts, providerIds);
    results.push({ step, outcome: ok ? "pass" : "fail" });

    // Pre-flight failing is the one result that should stop you. It means the
    // legal entity is not fit to link, and linking anyway defers the failure.
    if (!ok && step.key === "preflight") {
      console.log(
        c.bad(
          "\n  ⛔ Pre-flight FAILED. Linking now would carry an incomplete legal\n" +
            "     entity into the send path, where it fails as missing_required_fields."
        )
      );
      const go = await askChoice("Pre-flight failed — what now?", [
        { label: "Stop here (recommended)", aliases: ["stop"], value: "stop", default: true },
        { label: "Continue anyway", aliases: ["continue", "go"], value: "continue" },
      ]);
      if (go === "stop") {
        console.log(c.faint("\nStopped after pre-flight."));
        break;
      }
    } else if (!ok) {
      console.log(c.bad(`  ✗ ${step.key} exited non-zero.`));
    }
  }

  console.log(c.head("\n══ Walkthrough summary ══════════════════════════════════"));
  const mark = { pass: c.ok("✓ pass"), fail: c.bad("✗ fail"), skipped: c.faint("– skipped") };
  const done = new Set(results.map((r) => r.step.key));
  for (const step of WORKFLOW_STEPS) {
    const r = results.find((x) => x.step.key === step.key);
    console.log(
      `  ${r ? mark[r.outcome] : c.faint("· not reached")}   ${step.key}` +
        (step.writes ? "" : c.faint("  (read-only)"))
    );
  }

  const failed = results.filter((r) => r.outcome === "fail").length;
  if (!done.size) console.log(c.faint("  Nothing was run."));
  if (failed) process.exitCode = EXIT_DATA;
  return failed === 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();

  // --json: stdout carries the result document and nothing else, so every
  // human-readable line has to be rerouted before the first one is written.
  if (opts.json) startJsonMode();

  console.log("plugin_legal_entity_updates — plugins ↔ primary legal entities");

  // 1. Which mode? Asked first — it decides everything downstream, including
  //    whether this invocation needs a terminal at all. Any mode flag has already
  //    answered it; with no TTY a flag is the only way to answer it.
  if (!opts.mode) {
    if (!input.isTTY) {
      throw new UsageError(
        "No mode given, and no terminal to ask for one.\n" +
          "  Pass a mode flag: --preflight, --postflight, --plugins, --link,\n" +
          "  --migrate, --reset or --guided."
      );
    }
    opts.mode = await askMode();
  }

  // 1b. Now the mode is known, so "does this need a human?" can be answered.
  //     Read-only modes proceed under --yes; anything that writes does not.
  requireInteractive(opts);

  // Reset is destructive and has no undo, so it is staging-only — the same stance
  // clear_provider_einvoicing takes. Checked before anything else happens.
  if (opts.mode === "reset" && isProd(opts.namespace)) {
    throw new UsageError(
      `Refusing to reset against "${opts.namespace}".\n` +
        "  Reset deletes migration state, location assignments and the primary\n" +
        "  legal-entity pointer, and soft-deletes legal entities. There is no undo.\n" +
        "  STAGING ONLY."
    );
  }

  // 2. Environment — -n, or prompt. Before the reads, because discovering
  //    providers is itself a query against the chosen namespace.
  // Without a terminal there is nobody to ask, and -n has a default worth taking
  // (staging). An unattended run that meant production has to say so explicitly,
  // which is the right way round.
  if (!opts.namespaceGiven && input.isTTY) {
    opts.namespace = await askNamespace();
  }
  const env = psqlEnv(opts.namespace);

  // GUIDED — the walkthrough itself queries nothing, so it does not pass the read
  // gate; each step it spawns passes its own. Dispatched before that gate for
  // exactly that reason.
  if (opts.mode === "guided") {
    const providerIds = opts.providerIds
      ? parseProviderIds(opts.providerIds)
      : await askGuidedProviderIds();
    await runGuided(opts, providerIds);
    return;
  }

  // 3. Approve the data access itself, before any query goes out ------------
  if (!(await confirmDataAccess(opts, env))) {
    console.log("Aborted. Nothing was read.");
    emitJson(opts, { verdict: "ABORTED", read: false });
    return;
  }

  // RESET — staging only, already enforced above. Preview, then one transaction
  // per database.
  if (opts.mode === "reset") {
    const providerIds = opts.providerIds
      ? parseProviderIds(opts.providerIds)
      : await askResetProviderIds();

    console.log(
      `\nTarget: namespace=${opts.namespace} psql_env=${env}` + c.warn("   [STAGING ONLY]")
    );
    console.log(`Providers to reset: ${providerIds.length} — ${providerIds.join(", ")}`);

    // --keep-legal-entities already answered this.
    if (!opts.deleteLegalEntitiesGiven) {
      opts.deleteLegalEntities = await askDeleteLegalEntities();
    }

    let failures = 0;
    // Per-provider outcome, for --json. A reset is approved one provider at a time,
    // so "what actually happened" is a list, not a single verdict.
    const outcomes = [];

    // One provider at a time: each gets its own preview and its own confirmation.
    // A reset is not something to approve in bulk.
    for (const providerId of providerIds) {
      console.log(c.faint(`\nReading reset targets for provider=${providerId} (read-only)…`));
      const preview = fetchResetPreview(env, providerId);
      const total = printResetPreview(providerId, preview, opts);

      // The SQL is the plan — always shown, so you approve what will actually run.
      console.log(c.head("\n── SQL that will run ───────────────────────────────────"));
      console.log(c.sql(buildResetPluginSql(providerId)));
      console.log(c.sql(buildResetShedulSql(providerId)));
      if (opts.deleteLegalEntities && preview.legalEntityIds.length) {
        console.log(c.sql(buildResetLegalEntitySql(preview.legalEntityIds)));
      }

      if (!total && !preview.legalEntityIds.length) {
        console.log(c.faint(`\n  Nothing to reset for provider=${providerId}.`));
        outcomes.push({ provider_id: providerId, status: "nothing_to_reset", rows_left: 0 });
        continue;
      }

      console.log(
        c.bad(
          `\n  ⚠ This permanently deletes the rows above for provider=${providerId}. No undo.`
        )
      );
      const echo = (await ask(`  Type the provider_id (${providerId}) to confirm: `)).trim();
      if (echo !== String(providerId)) {
        console.error("  provider_id mismatch. Skipping this provider.");
        failures++;
        outcomes.push({ provider_id: providerId, status: "mismatch", rows_left: null });
        continue;
      }
      const final = (await ask('  Proceed? (type "yes"): ')).trim().toLowerCase();
      if (final !== "yes") {
        console.log(`  Skipped provider=${providerId}. Nothing was written.`);
        outcomes.push({ provider_id: providerId, status: "declined", rows_left: null });
        continue;
      }

      // Unlink the plugins first: while the plugin still points at the entity the
      // link is the thing most likely to confuse a later run.
      psqlWrite(opts.namespace, AD_DB, buildResetPluginSql(providerId), `plugins_${providerId}`);
      psqlWrite(opts.namespace, SHEDUL_DB, buildResetShedulSql(providerId), `shedul_${providerId}`);
      if (opts.deleteLegalEntities && preview.legalEntityIds.length) {
        psqlWrite(
          opts.namespace,
          LE_DB,
          buildResetLegalEntitySql(preview.legalEntityIds),
          `le_${providerId}`
        );
      }

      // Read back: everything should now be zero.
      console.log(c.faint(`\nVerifying provider=${providerId} (read-only)…`));
      const after = fetchResetPreview(env, providerId);
      const leftover =
        after.shedul.reduce((n, s) => n + s.count, 0) + after.linkedPlugins;

      if (leftover) {
        console.log(
          c.bad(`  ✗ provider=${providerId}: ${leftover} row(s) still present after reset.`)
        );
        for (const s of after.shedul.filter((x) => x.count)) {
          console.log(`      ${s.table} = ${s.count}`);
        }
        if (after.linkedPlugins) console.log(`      linked plugins = ${after.linkedPlugins}`);
        failures++;
        outcomes.push({ provider_id: providerId, status: "incomplete", rows_left: leftover });
      } else {
        console.log(c.ok(`  ✓ provider=${providerId} reset — all target rows cleared.`));
        outcomes.push({ provider_id: providerId, status: "reset", rows_left: 0 });
      }
    }

    console.log(
      failures
        ? c.bad("\n══ RESET: FAIL ═════════════════════════════════════════")
        : c.ok("\n══ RESET: PASS ═════════════════════════════════════════")
    );
    console.log(
      failures
        ? `  ${c.bad("✗")} ${failures} provider(s) not fully reset. See above.`
        : `  ${c.ok("✓")} done. Re-run migrate to recreate the legal entities.`
    );
    if (failures) process.exitCode = EXIT_DATA;

    emitJson(opts, {
      verdict: verdictOf(failures),
      soft_deleted_legal_entities: opts.deleteLegalEntities,
      providers: outcomes,
    });
    return;
  }

  // PLUGIN AUDIT — self-contained. Discovers providers from the plugins table (a
  // provider can have a config with no plugin, which has nothing to audit) and
  // compares billing info against each PLUGIN's own legal entity. Read-only.
  if (opts.mode === "plugins") {
    let providerIds;
    if (opts.providerIds) {
      providerIds = parseProviderIds(opts.providerIds);
    } else {
      console.log(c.faint(`\nFinding providers with plugins in ${AD_DB}…`));
      providerIds = fetchProviderIdsWithPlugins(env);
      if (!providerIds.length) throw new Error("No providers with account_configuration_plugins.");
      console.log(`Found ${providerIds.length} provider(s) with at least one plugin.`);
    }

    console.log(`\nTarget: namespace=${opts.namespace} psql_env=${env}`);

    console.log(c.faint(`\nReading plugins from ${AD_DB} (read-only)…`));
    const pluginsByProvider = fetchPlugins(env, providerIds);
    if (!pluginsByProvider.size) {
      console.log(c.warn("\nNone of these providers has a plugin — nothing to audit."));
      emitJson(opts, { verdict: "PASS", tally: { linked: 0, unlinked: 0 }, plugins: [] });
      return;
    }

    console.log(c.faint(`Reading primary legal entities from ${SHEDUL_DB} (read-only)…`));
    const primaryByProvider = fetchPrimaryLegalEntities(env, providerIds);

    console.log(c.faint(`Reading provider_billing_informations from ${SHEDUL_DB} (read-only)…`));
    const billing = fetchBillingInformations(env, providerIds);

    console.log(c.faint(`Reading account configuration countries from ${AD_DB} (read-only)…`));
    const countries = fetchAccountConfigCountries(env, providerIds);

    // Only the entities the plugins actually reference — not the primaries.
    const pluginLegalEntityIds = [
      ...new Set(
        [...pluginsByProvider.values()]
          .flat()
          .map((p) => p.legalEntityId)
          .filter(Boolean)
      ),
    ];
    console.log(c.faint(`Reading legal entity fields from ${LE_DB} (read-only)…`));
    const leFields = fetchLegalEntityFields(env, pluginLegalEntityIds);

    const audits = comparePlugins(
      pluginsByProvider,
      billing,
      leFields,
      countries,
      primaryByProvider
    );

    const detail = opts.detail === null ? providerIds.length <= 5 : opts.detail;
    const failed = printPluginAudit(opts, audits, detail);

    // Same export path as pre-flight — the linked audits carry the same shape.
    let wantMd = opts.md;
    // No terminal means nobody to offer it to — --md is how a non-interactive
    // caller asks for the export.
    if (!wantMd && input.isTTY) {
      const answer = (await ask("\n  Export this comparison as Markdown? (y/N): "))
        .trim()
        .toLowerCase();
      wantMd = answer === "y" || answer === "yes";
    }
    if (wantMd) {
      const linked = audits.filter((a) => !a.unlinked);
      const target = preflightMarkdownPath(opts);
      fs.writeFileSync(
        target,
        buildPreflightMarkdown(
          opts,
          linked,
          {
            clean: linked.filter((a) => !a.blocking.length && !a.diffs.length).length,
            noBilling: 0,
            differ: linked.filter((a) => a.diffs.length).length,
            blocked: linked.filter((a) => a.blocking.length).length,
          },
          [],
          detail,
          "Plugin audit — provider billing informations vs each plugin's legal entity"
        )
      );
      console.log(`  ${c.ok("✓")} written: ${target}`);
    }

    if (failed) process.exitCode = EXIT_DATA;

    emitJson(opts, {
      verdict: verdictOf(failed),
      tally: {
        linked: audits.filter((a) => !a.unlinked).length,
        unlinked: audits.filter((a) => a.unlinked).length,
        blocked: audits.filter((a) => !a.unlinked && a.blocking.length).length,
        differ: audits.filter((a) => !a.unlinked && a.diffs.length).length,
        diverged: audits.filter((a) => a.diverged).length,
      },
      // One entry per PLUGIN, not per provider: a provider can hold more than one,
      // and the send path reads whichever the plugin points at.
      plugins: audits.map((a) => ({
        provider_id: a.providerId,
        plugin_id: Number(a.plugin.id),
        plugin_type: a.plugin.pluginType || null,
        integrator: a.plugin.integrator || null,
        plugin_status: a.plugin.pluginStatus || null,
        legal_entity_id: a.plugin.legalEntityId || null,
        primary_legal_entity_id: a.primary,
        // Points at something other than the provider's primary — not wrong by
        // itself, but pre-flight is then comparing a different entity.
        diverged: Boolean(a.diverged),
        ...(a.unlinked
          ? { status: "unlinked", country_code: a.countryCode || null }
          : jsonComparison(a)),
      })),
    });
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

    // --no-payment-methods already answered this.
    if (!opts.migratePaymentMethodsGiven) {
      opts.migratePaymentMethods = await askMigratePaymentMethods();
    }

    // Preview stands in for the dry run this task doesn't have.
    console.log(c.faint(`\nReading migration state from ${SHEDUL_DB} (read-only)…`));
    const before = fetchMigrationStatuses(env, providerIds);
    printMigratePreview(providerIds, before);

    console.log(c.head("\n── Command ─────────────────────────────────────────────"));
    console.log(`\n${c.cmd(buildMigrateCommand(opts, providerIds))}\n`);

    printMigrateWarning(opts);

    // --print-only: the command is the deliverable. Nothing runs, so nothing needs
    // approving — which is also why this sits before the gate.
    if (opts.printOnly) {
      console.log(c.faint("--print-only: nothing was run."));
      emitJson(opts, {
        verdict: "PRINTED",
        command: buildMigrateCommand(opts, providerIds),
        migrate_payment_methods: opts.migratePaymentMethods,
        providers: providerIds.map((id) => ({
          provider_id: id,
          before: migrateVerdict(before.get(id)),
        })),
      });
      return;
    }

    if (!(await confirmRun(opts))) {
      console.log("Aborted. Nothing was run.");
      emitJson(opts, { verdict: "ABORTED", ran: false });
      return;
    }

    runInherit("houston", [...migrateTaskArgs(opts, providerIds), "--no-tui", "-w"]);

    console.log(c.faint(`\nVerifying against ${SHEDUL_DB} (read-only)…`));
    const after = fetchMigrationStatuses(env, providerIds);
    const migrateFailed = printMigrateReadback(providerIds, before, after);
    if (migrateFailed) process.exitCode = EXIT_DATA;

    emitJson(opts, {
      verdict: verdictOf(migrateFailed),
      command: buildMigrateCommand(opts, providerIds),
      migrate_payment_methods: opts.migratePaymentMethods,
      // This task is resumable and has no dry run, so before/after is the only way
      // to tell "it worked" from "it was already done".
      providers: providerIds.map((id) => ({
        provider_id: id,
        before: migrateVerdict(before.get(id)),
        after: migrateVerdict(after.get(id)),
      })),
    });
    return;
  }

  // 4. Provider IDs — given as arguments, or asked for --------------------
  let providerIds;
  if (opts.providerIds) {
    providerIds = parseProviderIds(opts.providerIds);
  } else if (opts.all) {
    console.log(c.faint(`\nFinding providers in ${AD_DB}.account_configurations…`));
    providerIds = fetchAllProviderIds(env);
    if (!providerIds.length) throw new Error("No providers found in account_configurations.");
  } else if (!input.isTTY) {
    // Nobody to ask, and guessing is not an option: "every provider" and "these
    // three" are very different requests. Name the flag rather than pick one.
    throw new UsageError(
      "No providers given, and no terminal to ask for them.\n" +
        "  Pass provider IDs (e.g. 33,41), --all for every provider with an\n" +
        "  account configuration, or -f/--file PATH to read them from a file."
    );
  } else {
    const chosen = await askProviderIds(env);
    providerIds = chosen.ids;
    opts.all = chosen.all;
  }

  console.log(`\nTarget: namespace=${opts.namespace} psql_env=${env} service=${opts.service}`);
  console.log(`Providers requested: ${providerIds.length} — ${providerIds.join(", ")}`);

  // 5. Resolve primary legal entities (shedul) -----------------------------
  console.log(c.faint(`\nReading primary legal entities from ${SHEDUL_DB} (read-only)…`));
  const primaryByProvider = fetchPrimaryLegalEntities(env, providerIds);

  // PRE-FLIGHT stops here. It never touches plugins — it asks only whether the
  // data on the two sides agrees, which is what you want to know *before*
  // linking anything. Strictly SELECTs.
  if (opts.mode === "preflight") {
    const withLegalEntity = providerIds.filter((id) => primaryByProvider.has(id));

    // Read billing info for EVERY provider, not only those with a primary legal
    // entity. The ones without are the reason: migrate builds the entity FROM this
    // table, so whether the row exists is exactly what separates "waiting for
    // migrate" from "migrate would have nothing to build from".
    console.log(c.faint(`Reading provider_billing_informations from ${SHEDUL_DB} (read-only)…`));
    const billing = fetchBillingInformations(env, providerIds);

    const missing = providerIds
      .filter((id) => !primaryByProvider.has(id))
      .map((id) => ({ providerId: id, hasBilling: Boolean(billing.get(id)) }));

    // Nothing comparable at all is a FAIL, and the loudest thing on screen. Every
    // mode downstream reads the same primary pointer, so there is no next step that
    // could work either — and a green PASS here would be approval of data nobody
    // looked at. (A run where only SOME providers lack a pointer still passes on
    // the rest; see printPreflightVerdict for why the two differ.)
    if (!withLegalEntity.length) {
      printNoPrimaryLegalEntity(missing);
      console.log(verdictBanner(true));
      console.log(
        `  ${c.bad("⊘")} Nothing was compared — ` +
          (providerIds.length === 1
            ? `provider=${providerIds[0]} has no active primary legal entity.`
            : `not one of these ${providerIds.length} providers has an active ` +
              "primary legal entity.")
      );
      console.log(
        c.bad(
          wrapText(
            "Going further is pointless: link has nothing to link and post-flight " +
              "nothing to audit. Run migrate first.",
            "",
            4
          )
        )
      );
      console.log(c.faint("\n  Read-only: this mode issues SELECTs and nothing else."));

      // Set before emitJson — the envelope reports process.exitCode as `exit`.
      process.exitCode = EXIT_DATA;
      emitJson(opts, {
        verdict: verdictOf(true),
        tally: { clean: 0, differ: 0, blocked: 0, no_primary_legal_entity: providerIds.length },
        providers: [],
        skipped: missing.map(({ providerId, hasBilling }) => ({
          provider_id: providerId,
          reason: "no active primary legal entity",
          has_billing_details: hasBilling,
        })),
      });
      return;
    }

    console.log(c.faint(`Reading legal entity fields from ${LE_DB} (read-only)…`));
    const leFields = fetchLegalEntityFields(env, [
      ...new Set(withLegalEntity.map((id) => primaryByProvider.get(id))),
    ]);

    // Which validator applies is decided by the account configuration's country,
    // so the required-field set has to come from there.
    console.log(c.faint(`Reading account configuration countries from ${AD_DB} (read-only)…`));
    const countries = fetchAccountConfigCountries(env, withLegalEntity);

    const comparisons = withLegalEntity.map((id) =>
      compareFields(
        id,
        billing.get(id),
        leFields.get(primaryByProvider.get(id)),
        countries.get(id)
      )
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

    const tally = printFieldComparison(comparisons, missing);
    printNoPrimaryLegalEntity(missing);

    // KYC / payments gate — a separate concern from field consistency, but the
    // other thing that decides whether a provider can onboard.
    console.log(c.faint(`\nReading payments status from ${SHEDUL_DB} (read-only)…`));
    const payments = fetchPaymentsEnabled(env, withLegalEntity);

    console.log(c.faint(`Reading KYC-provider links from ${LE_DB} (read-only)…`));
    const kycSync = fetchKycSync(env, [
      ...new Set(withLegalEntity.map((id) => primaryByProvider.get(id))),
    ]);

    const adyenIds = [...new Set([...kycSync.values()].filter(Boolean))];
    let adyenById = new Map();
    if (adyenIds.length) {
      console.log(c.faint(`Reading verifications from ${ADYEN_DB} (read-only)…`));
      adyenById = fetchAdyenVerifications(env, adyenIds);
    }

    const kycRows = withLegalEntity.map((id) => {
      const adyenLegalEntityId = kycSync.get(primaryByProvider.get(id)) || null;
      const row = {
        providerId: id,
        payments: payments.get(id) || "unknown",
        adyenLegalEntityId,
        adyen: adyenLegalEntityId ? adyenById.get(adyenLegalEntityId) || null : null,
      };
      return { ...row, verdict: kycVerdict(row) };
    });

    printKycStatus(kycRows);

    const failed = printPreflightVerdict(tally, missing);

    // Export. --md writes without asking; otherwise it's offered, because a flag
    // nobody remembers is a flag that doesn't exist.
    let wantMd = opts.md;
    // No terminal means nobody to offer it to — --md is how a non-interactive
    // caller asks for the export.
    if (!wantMd && input.isTTY) {
      const answer = (await ask("\n  Export this comparison as Markdown? (y/N): "))
        .trim()
        .toLowerCase();
      wantMd = answer === "y" || answer === "yes";
    }

    if (wantMd) {
      const target = preflightMarkdownPath(opts);
      fs.writeFileSync(
        target,
        buildPreflightMarkdown(opts, comparisons, tally, missing, detail, null, kycRows)
      );
      console.log(`  ${c.ok("✓")} written: ${target}`);
    }

    if (failed) process.exitCode = EXIT_DATA;

    emitJson(opts, {
      verdict: verdictOf(failed),
      tally: {
        clean: tally.clean,
        differ: tally.differ,
        blocked: tally.blocked,
        no_billing_info: tally.noBilling,
        no_primary_legal_entity: missing.length,
      },
      providers: comparisons.map((cmp) => ({
        ...jsonComparison(cmp),
        primary_legal_entity_id: primaryByProvider.get(cmp.providerId) || null,
      })),
      // The other thing that blocks onboarding. "unknown" is not a pass: the
      // authoritative verification lives behind the adyen-platform RPC, so the
      // database cannot confirm it either way.
      kyc: kycRows.map((r) => ({
        provider_id: r.providerId,
        payments: r.payments,
        synced_to_kyc_provider: Boolean(r.adyenLegalEntityId),
        adyen_legal_entity_id: r.adyenLegalEntityId,
        gate: r.verdict.state,
        detail: r.verdict.text,
        // Whether the database can prove this. false means the authoritative
        // answer is behind the adyen-platform RPC — do not treat it as decided.
        exact: r.verdict.exact,
      })),
      skipped: missing.map(({ providerId, hasBilling }) => ({
        provider_id: providerId,
        reason: "no active primary legal entity",
        has_billing_details: hasBilling,
      })),
    });
    return;
  }

  // 6. Resolve plugins (accounting_documents) ------------------------------
  console.log(c.faint(`Reading plugins from ${AD_DB} (read-only)…`));
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

    if (drift) process.exitCode = EXIT_DATA;

    emitJson(opts, {
      verdict: verdictOf(drift),
      tally: {
        ok: audit.filter((a) => a.state === "ok").length,
        drift: audit.filter((a) => a.state === "drift").length,
        exempt: audit.filter((a) => a.state === "exempt").length,
      },
      providers: audit.map((a) => ({
        provider_id: a.providerId,
        // "exempt" is a pass: nothing to link, so nothing can be wrong.
        status: a.state,
        detail: a.status,
        plugin_id: a.plugin ? Number(a.plugin.id) : null,
        expected_legal_entity_id: a.expected,
        actual_legal_entity_id: a.plugin ? a.plugin.legalEntityId || null : null,
      })),
    });
    return;
  }

  // 7. Pair them up --------------------------------------------------------
  const { updates, skipped } = resolve(providerIds, primaryByProvider, pluginsByProvider);


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
    // Nothing to do is a pass, not a failure — every provider was either already
    // linked or exempt, and both are correct states.
    emitJson(opts, {
      verdict: "PASS",
      dry_run: !opts.apply,
      command: null,
      tally: { requested: 0, verified: 0, failed: 0, skipped: skipped.length },
      updates: [],
      skipped: skipped.map((s) => ({ provider_id: s.providerId, reason: s.reason })),
    });
    return;
  }

  // 8. Dry run or apply — --apply/--dry-run, or prompt ---------------------
  // Asked here, after the report, so the decision is made with the actual
  // plugin list on screen.
  // --apply / --dry-run already answered this. Without a terminal there is nobody
  // to ask, and the safe reading of silence is a dry run — requireInteractive()
  // only let us this far because apply was false.
  if (!opts.applyGiven && input.isTTY) {
    opts.apply = await askApply(opts.namespace);
  }

  // 9. Print the command ---------------------------------------------------
  console.log(
    c.head("\n── Command ─────────────────────────────────────────────") +
      (opts.apply ? "" : c.faint("\n(DRY_RUN=true — logs only, writes nothing)"))
  );
  console.log(`\n${c.cmd(buildCommand(opts, updates))}\n`);

  // --print-only stops here: the command above is the whole deliverable. Nothing
  // has been run and nothing needs approving, so there is no gate to pass.
  if (opts.printOnly) {
    console.log(c.faint("--print-only: nothing was run."));
    emitJson(opts, {
      verdict: "PRINTED",
      dry_run: !opts.apply,
      command: buildCommand(opts, updates),
      updates: updates.map((u) => ({
        provider_id: u._providerId,
        plugin_id: u.plugin_id,
        legal_entity_id: u.legal_entity_id,
      })),
      skipped: skipped.map((s) => ({ provider_id: s.providerId, reason: s.reason })),
    });
    return;
  }

  // 10. Confirm + run -------------------------------------------------------
  // --no-tui -w are appended so the task's logs stream into this terminal;
  // runInherit echoes the full argv before it spawns.
  if (!(await confirmRun(opts))) {
    console.log("Aborted. Nothing was run.");
    emitJson(opts, { verdict: "ABORTED", ran: false, command: buildCommand(opts, updates) });
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
    process.exitCode = EXIT_DATA;
  } else {
    console.log(
      `\n✓ Ran ${TASK} for ${scope}` +
        (opts.apply ? " — all verified." : " (DRY_RUN=true — nothing written, verified unchanged).")
    );
  }

  // The read-back is the only evidence that anything landed: the task exits 0 even
  // when it skips every row, so `verified` — not the exit code — is the signal.
  emitJson(opts, {
    verdict: verdictOf(failures),
    dry_run: !opts.apply,
    command: buildCommand(opts, updates),
    tally: {
      requested: updates.length,
      verified: updates.length - failures,
      failed: failures,
      skipped: skipped.length,
    },
    // verdictFor carries the dry-run semantics — "verified" on a dry run means the
    // row is still NULL, not that it matches. Reused rather than re-derived so the
    // JSON and the table can never disagree.
    updates: updates.map((u) => {
      const verdict = verdictFor(u, applied, !opts.apply);
      return {
        provider_id: u._providerId,
        plugin_id: u.plugin_id,
        legal_entity_id: u.legal_entity_id,
        applied_legal_entity_id: applied.get(String(u.plugin_id)) ?? null,
        verified: verdict.ok,
        detail: verdict.note,
      };
    }),
    skipped: skipped.map((s) => ({ provider_id: s.providerId, reason: s.reason })),
  });
}

main()
  .catch((err) => {
    console.error(`\nError: ${err.message}`);
    // A UsageError carries its own code: "the call was wrong" is a different
    // outcome from "the data was wrong", and a caller needs to tell them apart.
    process.exitCode = err.exitCode || EXIT_DATA;
    if (jsonMode) {
      process.stdout.write(
        `${JSON.stringify(
          { schema_version: 1, verdict: "ERROR", exit: process.exitCode, error: err.message },
          null,
          2
        )}\n`
      );
    }
  })
  // The single readline holds the event loop open; always let go of stdin.
  .finally(closeRl);
