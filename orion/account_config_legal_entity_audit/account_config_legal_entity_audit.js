#!/usr/bin/env node
//
// account_config_legal_entity_audit — where has a provider's tax identity drifted
// away from its legal entity?
//
// app-accounting-documents stores a provider's tax identity TWICE:
//
//   accounting_documents.account_configurations
//                       tax_id / vat_number / company_registration_number /
//                       country_code — mirrored onto the plugin as
//                       parent_number / branch_number / country_code.
//   legal_entities.legal_entities
//                       the post-Billing-Profiles system of record, reached via
//                       account_configuration_plugins.legal_entity_id.
//
// THE TWO ARE SNAPSHOTS, NOT A LINK. AccountConfigurations.maybe_update_tax_id/2 and
// maybe_update_company_registration_number/2 refresh the columns only on a
// re-onboarding, or when an operator runs UpdateAccountConfigurationTaxIdTask. Nothing
// subscribes to legal-entity change events, so a legal entity edited after onboarding
// leaves the accounting-documents columns silently stale.
//
// That still matters even though the payload builders no longer read those columns:
// `tax_id` and `company_registration_number` back the onboarding uniqueness pre-check
// (get_enabled_plugins_by_tax_id_and_crn/3), and the KSA processor falls back to the
// configuration's CRN for Fresha-issued B2B. A stale tax_id wrongly passes or fails the
// next uniqueness check.
//
// Pipeline:
//   1. accounting_documents — every account_configuration LEFT JOINed to its plugins.
//      The LEFT JOIN is deliberate: a configuration with no plugin at all is itself a
//      finding, and an inner join would hide it.
//   2. legal_entities — the fields of every legal entity those plugins point at, root
//      AND child, id-filtered and chunked.
//   3. Compare in Node (the databases are separate; there is no cross-database join).
//
// THE COMPARISON IS PLUGIN-LEVEL, NOT CONFIGURATION-LEVEL. This is not a stylistic
// choice. Provider 1135636 holds two enabled plugins against one configuration: the
// default one carries the account's CRN in branch_number, and the branch one carries a
// DIFFERENT CRN (1010880577) with its own legal entity. Both are correct — the CRNs are
// hardcoded in comarch/billing_details_policy.ex @ksa_location_branch_numbers. Comparing
// account_configurations.company_registration_number against every plugin's legal entity
// therefore invents a conflict for the branch plugin. Comparing plugins.branch_number
// does not. (is_default alone cannot tell them apart: default plugins also carry the
// account CRN there — see get_account_configuration_query.ex.)
//
// WHAT IS NOT COMPARED, AND WHY:
//   configuration jsonb   `{}` on all 442 production rows. No embedded schema, no
//                         per-country variant, zero reads anywhere in src/. There is
//                         nothing in it to compare.
//   enabled               dead — not even in the Ecto schema. Enablement is decided off
//                         account_configuration_plugins.plugin_status.
//   vat_number            a write-only duplicate of tax_id: maybe_update_tax_id/2 sets
//                         both from the same billing_details.tax_number. Asserted equal
//                         in the internal-consistency section rather than compared twice.
//   currency_code         no legal-entity counterpart. Carried as context only.
//
// THE TAX NUMBER SLOT IS `*.vatNumber`, NOT `*.taxInformation.number`. The legal-entities
// invoice projection emits the former as IDENTIFIER_KIND_TAX_NUMBER and the latter as
// IDENTIFIER_KIND_TAX_IDENTIFICATION_NUMBER — a different kind, which
// LegalEntityBillingDetails does not read for `tax_number`. Probing the TIN slot would
// report a tax number as present that the RPC leaves nil.
//
// SOLE TRADERS KEEP THEIR IDENTIFIERS ON THE CHILD ENTITY (soleProprietorship.*), joined
// through legal_entity_associations. Reading the root alone reports every populated ES/IT
// provider as missing everything. The shape table below is what decides where to look.
//
// SAFETY
//   - Read-only, and structurally so: there is no `houston psql --write` and no
//     `houston task run` anywhere in this file. That absence is the safety property —
//     grep for it.
//   - Every statement is echoed before it runs. NO_COLOR is honoured.
//   - The read is gated behind an approval prompt that names the namespace and both
//     databases first. --yes is that approval for automation; it cannot approve a write,
//     because there is no write to approve.
//
// Usage: ./account_config_legal_entity_audit.js [flags]   (-h for all of them)
// Prereqs: VPN up, `houston` authenticated (prod reads use the
// fresha-production-developer profile). Node only, no dependencies.

"use strict";

const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// --- constants ---------------------------------------------------------------

const AD_DB = "accounting_documents";
const LE_DB = "legal_entities";

const DEFAULT_NAMESPACE = "production";
const PROD_NAMESPACES = new Set(["production", "prod"]);

// ids per IN(...) statement. The legal-entity field query unnests a jsonb array per row,
// so a single unbounded statement is both unreadable and slow.
const CHUNK = 500;

const DASH = "—";

const EXIT_DATA = 1; // the data is wrong: a conflict, a dangling reference
const EXIT_USAGE = 2; // the call was wrong, or approval was refused

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = EXIT_USAGE;
  }
}

// --- colour ------------------------------------------------------------------
//
// House convention: cyan for SQL, yellow for a command you could run yourself,
// bright white for section headers, faint for progress. Off when stdout isn't a
// terminal, or when NO_COLOR is set (https://no-color.org).

const COLOR = output.isTTY && !process.env.NO_COLOR;
const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));

const c = {
  sql: sgr("36"),
  cmd: sgr("33"),
  head: sgr("1;37"),
  faint: sgr("2"),
  ok: sgr("32"),
  bad: sgr("1;31"),
  warn: sgr("1;33"),
};

// Where prompts and progress are written. --json keeps stdout pure for the payload,
// so its gate has to talk on stderr instead. Set once, before the first ask().
let promptStream = output;

const SQL_ECHO_LIMIT = 500;

function echoSql(label, sql) {
  const shown =
    sql.length > SQL_ECHO_LIMIT
      ? `${sql.slice(0, SQL_ECHO_LIMIT)}\n… (${sql.length - SQL_ECHO_LIMIT} more chars)`
      : sql;

  promptStream.write(`  ${c.faint(label)}\n`);
  for (const line of shown.split("\n")) promptStream.write(`    ${c.sql(line)}\n`);
}

// --- json output -------------------------------------------------------------
//
// The contract: with --json, stdout carries exactly one JSON document and nothing
// else; every line a human would read goes to stderr. Rerouting `console` once,
// here, beats threading a stream through every call site where one missed call
// would silently corrupt the payload.

let jsonMode = false;

function startJsonMode() {
  jsonMode = true;
  promptStream = process.stderr;
  const toStderr = (...args) => process.stderr.write(`${args.join(" ")}\n`);
  console.log = toStderr;
  console.info = toStderr;
  // console.error and console.warn already write to stderr.
}

// --- prompting ---------------------------------------------------------------
//
// One readline for the whole run, with a line queue. The per-question
// createInterface pattern silently loses answers when stdin is a pipe: the second
// interface swallows lines the first had already buffered.

let rl = null;
let inputClosed = false;
const bufferedLines = [];
const waitingAskers = [];

function ensureRl() {
  if (rl) return rl;

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
// Ctrl-D, or a piped script one line short, must not answer a prompt for you.
function endOfInput() {
  throw new UsageError("Input ended before the prompt was answered. Aborting; nothing was read.");
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

// Like ask(), but a closed stdin yields the fallback instead of aborting. Reserved for
// questions with no safety consequence: "also write a CSV?" is not an approval.
async function askOptional(question, fallback) {
  ensureRl();
  promptStream.write(question);

  const skipped = () => {
    promptStream.write(`${c.faint("(no input — skipped)")}\n`);
    return fallback;
  };

  if (bufferedLines.length) return bufferedLines.shift();
  if (inputClosed) return skipped();

  const line = await new Promise((resolve) => waitingAskers.push(resolve));
  return line === null ? skipped() : line;
}

async function askChoice(title, choices) {
  const def = choices.find((ch) => ch.default) || choices[0];

  promptStream.write(`\n${c.head(title)}\n`);
  choices.forEach((ch, i) => {
    const marker = ch === def ? c.faint(" (default)") : "";
    promptStream.write(`  ${i + 1}) ${ch.label}${marker}\n`);
    if (ch.detail) promptStream.write(`     ${c.faint(ch.detail)}\n`);
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = (await ask("  > ")).trim().toLowerCase();
    if (!raw) return def.value;

    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].value;

    const match = choices.find((ch) => (ch.aliases || []).includes(raw));
    if (match) return match.value;

    promptStream.write(
      `  ${c.bad(`Not an option. Enter 1-${choices.length}, a name, or blank for the default.`)}\n`
    );
  }
  throw new UsageError("Too many invalid answers.");
}

// --- psql --------------------------------------------------------------------

function isProd(namespace) {
  return PROD_NAMESPACES.has(String(namespace).toLowerCase());
}

function psqlEnv(namespace) {
  return namespace === "production" ? "production" : namespace;
}

function runCapture(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${cmd} exited ${res.status}\n${res.stderr || ""}${res.stdout || ""}`.trim());
  }
  return res.stdout;
}

// Read-only psql. -t -A -F| gives bare pipe-delimited rows; a NULL column comes back
// as an empty field, which is why every nullable column below is wrapped in coalesce()
// — an empty field is then unambiguous rather than "NULL or ''".
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

// Split psql output into per-row field arrays. `houston psql` prefixes its output with
// a correlation-id / timestamp preamble, so drop any line without the expected field
// count.
function parseRows(out, fieldCount) {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => line.split("|"))
    .filter((fields) => fields.length === fieldCount);
}

// Like parseRows, but tolerant of the delimiter appearing inside the LAST field — a
// legal name can legitimately contain a "|". Everything past the (n-1)th delimiter is
// rejoined into the final column.
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

function chunked(items, size = CHUNK) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// --- value guards ------------------------------------------------------------
//
// Everything interpolated into a statement passes through one of these first. Nothing
// here comes from a place that could smuggle SQL — the ids are typed by a human or read
// back out of the database — but a read against production is not the place to rely on
// that.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function guardInt(value, what) {
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) throw new Error(`Expected an integer for ${what}, got: ${value}`);
  return s;
}

function guardUuid(value, what) {
  const s = String(value).trim();
  if (!UUID_RE.test(s)) throw new Error(`Expected a uuid for ${what}, got: ${value}`);
  return s;
}

function guardCountry(value) {
  const s = String(value).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(s)) throw new UsageError(`Expected a 2-letter country code, got: ${value}`);
  return s;
}

// --- entity shapes -----------------------------------------------------------
//
// A legal entity is TWO rows, not one. The root carries `business_type` (8 values); its
// child, when it has one, carries `type` and a NULL business_type. A check constraint
// keeps them complementary — app-legal-entities migration
// 20260511130000_require_business_type_on_root_legal_entities:
//
//   root  → type IN (individual, organization) AND business_type IS NOT NULL
//   child → type IN (sole_proprietorship, trust, unincorporated_partnership)
//           AND business_type IS NULL
//
// They are linked by the join table `legal_entity_associations`; there is NO parent_id
// column. At most one child per root.
//
// `business_type` decides where a field lives. The two traps this table exists to avoid:
//
//   * a sole trader keeps its identifiers AND address on the CHILD, under
//     `soleProprietorship.*`. Its root holds only the person's name. Reading the root
//     alone reports a complete provider as missing everything.
//   * identifier_keys/2 returns an EMPTY list for (individual, trust): an individual
//     trust emits no identifiers at all, so a tax number can never be satisfied there —
//     a different finding from "nobody filled it in".
//
// Source of truth: app-legal-entities fields_configuration/business_types.ex
// entity_type_for/2. Copied from plugin_legal_entity_updates.js rather than re-derived.
const ENTITY_SHAPES = {
  organization: {
    root: "organization", child: null,
    addr: "organization.registeredAddress", ident: "organization",
  },
  partnership_incorporated: {
    root: "organization", child: null,
    addr: "organization.registeredAddress", ident: "organization",
  },
  association_incorporated: {
    root: "organization", child: null,
    addr: "organization.registeredAddress", ident: "organization",
  },
  non_profit: {
    root: "organization", child: null,
    addr: "organization.registeredAddress", ident: "organization",
  },
  // A corporate trustee is the invoicing party, so address + identifiers come from the
  // organization root; only the NAME comes from the trust child.
  organization_trust: {
    root: "organization", child: "trust",
    addr: "organization.registeredAddress", ident: "organization",
  },
  sole_proprietorship: {
    root: "individual", child: "sole_proprietorship",
    addr: "soleProprietorship.registeredAddress", ident: "soleProprietorship",
  },
  unincorporated_partnership: {
    root: "individual", child: "unincorporated_partnership",
    addr: "unincorporatedPartnership.registeredAddress", ident: "unincorporatedPartnership",
  },
  // ident: null — an individual trust emits no identifiers whatsoever.
  individual_trust: {
    root: "individual", child: "trust",
    addr: "individual.residentialAddress", ident: null,
  },
};

// Pre-hierarchy rows have a NULL business_type. Fall back to the old binary guess so
// legacy data still reports rather than crashing.
function shapeFor(businessType, entityType) {
  if (businessType && ENTITY_SHAPES[businessType]) {
    return { key: businessType, ...ENTITY_SHAPES[businessType] };
  }
  const legacy = entityType === "individual" ? "sole_proprietorship" : "organization";
  return {
    key: businessType || `${entityType || "unknown"} (no business_type)`,
    legacy: true,
    ...ENTITY_SHAPES[legacy],
  };
}

// --- the field map -----------------------------------------------------------
//
// What accounting-documents holds vs what the legal entity holds. `slot` names WHICH
// part of the invoice projection carries the field; the actual jsonb key is derived from
// the entity's shape at comparison time (leKeysFor). That indirection is the point: a
// static key list cannot be right for both an organization root and a sole trader's
// child.
//
// The accounting-documents side is read off the PLUGIN, not the configuration — see the
// branch-plugin note in the header.
const FIELD_COMPARISON = [
  {
    key: "tax_number",
    label: "tax / VAT no.",
    ad: "parentNumber",
    adSource: "plugins.parent_number",
    slot: { kind: "identifier", sub: "vatNumber" },
    formatField: "tax_number",
    // Only the tax number gets the country-prefix equivalence: tax_id_variants/2 is
    // what the application itself applies to this value and nothing else.
    prefixable: true,
  },
  {
    key: "registration_number",
    label: "registration no.",
    ad: "branchNumber",
    adSource: "plugins.branch_number",
    slot: { kind: "identifier", sub: "registrationNumber" },
    formatField: "company_registration_number",
  },
  {
    key: "country",
    label: "country",
    ad: "pluginCountryCode",
    adSource: "plugins.country_code",
    // The COLUMN first, deliberately. Address.extract/2 always takes country_code from
    // the root's column, never a field, so the column is the authoritative answer and
    // the address key is only a nicety when it happens to be populated.
    slot: { kind: "address", sub: "country", columnFirst: "_column.country_code" },
  },
];

// Resolve a spec's candidate legal-entity keys against a shape, in priority order. An
// empty array means this shape has NO slot for the field — a fact about the entity type,
// not a missing value.
function leKeysFor(shape, spec) {
  const s = spec.slot;
  if (!s) return [];
  switch (s.kind) {
    case "address":
      return [...(s.columnFirst ? [s.columnFirst] : []), `${shape.addr}.${s.sub}`];
    case "identifier":
      return shape.ident ? [`${shape.ident}.${s.sub}`] : [];
    default:
      throw new Error(`unknown slot kind: ${s.kind}`);
  }
}

// --- formats -----------------------------------------------------------------
//
// Presence is not the only bar. AccountingDocuments.Helpers.ValidationHelpers enforces
// KSA *formats*, which a present-but-malformed value fails:
//
//   valid_ksa_crn?    — exactly 10 characters
//   valid_ksa_tax_id? — ~r/^3\d{12}03$/ : 15 digits, starts "3", ends "03"
//
// Applied to BOTH sides here, because which side fails is the whole finding: 9 of the 12
// production SA tax-number conflicts are a malformed accounting-documents value against
// a well-formed legal entity, which says the legal entity is right and the column is
// corrupt. A conflict where both sides are well-formed says something else entirely.
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

// --- country-prefix equivalence ----------------------------------------------
//
// A port of AccountConfigurations.tax_id_variants/2. A tax number reaches the service
// with or without its country prefix depending on the source, and the application treats
// all three spellings as the same value when it looks one up. So two sides that differ
// only by the prefix are not in conflict — they are the same tax number, and calling it
// a discrepancy would bury the 12 real ones under 5 false ones.
//
// The value AS GIVEN is always a candidate. Were only the stripped form used, a tax
// number that merely starts with a country code (an Italian codice fiscale beginning
// "SA…") would be looked up under a value nobody stored.
const KNOWN_COUNTRY_PREFIXES = ["ES", "IT", "SA"];

function maybeStripCountryPrefix(upper) {
  for (const prefix of KNOWN_COUNTRY_PREFIXES) {
    if (upper.startsWith(prefix)) return upper.slice(prefix.length);
  }
  return upper;
}

function taxIdVariants(value, countryCode) {
  const upper = String(value || "").trim().toUpperCase();
  if (!upper) return [];
  const bare = maybeStripCountryPrefix(upper);
  return [...new Set([upper, bare, String(countryCode || "").toUpperCase() + bare])];
}

// Equal under the application's own normalisation, without being the same string.
function prefixEquivalent(a, b, countryCode) {
  const left = taxIdVariants(a, countryCode);
  const right = taxIdVariants(b, countryCode);
  return left.some((v) => right.includes(v));
}

// Trim + collapse whitespace + case-fold. The application upcases both sides before
// comparing, so a case-only difference is not a discrepancy either.
function normalizeValue(v) {
  return String(v || "").trim().replace(/\s+/g, " ").toLowerCase();
}

// --- queries -----------------------------------------------------------------

// Every account_configuration and its plugins. One row per (configuration, plugin), and
// one row with an empty plugin id for a configuration that has none — the LEFT JOIN is
// what makes that case visible instead of silently absent.
//
// No country or provider filter in SQL: the whole table is 442 rows, and filtering in
// Node keeps the totals honest (a filtered run can still say what it excluded).
function fetchConfigurations(env) {
  const sql =
    "SELECT ac.id::text, coalesce(ac.provider_id::text, ''),\n" +
    "       coalesce(ac.invoice_entity_id::text, ''),\n" +
    "       coalesce(ac.fresha_billing_entity_id::text, ''),\n" +
    "       ac.country_code, coalesce(ac.tax_id, ''), coalesce(ac.vat_number, ''),\n" +
    "       coalesce(ac.company_registration_number, ''),\n" +
    "       coalesce(ac.currency_code, ''), (ac.deleted_at IS NOT NULL)::text,\n" +
    "       coalesce(p.id::text, ''), coalesce(p.legal_entity_id::text, ''),\n" +
    "       coalesce(p.integration::text, ''), coalesce(p.plugin_status::text, ''),\n" +
    "       coalesce(p.is_default::text, ''), coalesce(p.country_code, ''),\n" +
    "       coalesce(p.parent_number, ''), coalesce(p.branch_number, ''),\n" +
    "       coalesce(p.provider_id::text, '')\n" +
    "FROM account_configurations ac\n" +
    "LEFT JOIN account_configuration_plugins p ON p.account_configuration_id = ac.id\n" +
    "ORDER BY ac.id, p.id;";

  const rows = [];
  for (const f of parseRowsLoose(psqlRead(env, AD_DB, sql), 19)) {
    rows.push({
      configId: f[0],
      providerId: f[1],
      invoiceEntityId: f[2],
      freshaBillingEntityId: f[3],
      configCountryCode: f[4],
      taxId: f[5],
      vatNumber: f[6],
      companyRegistrationNumber: f[7],
      currencyCode: f[8],
      configDeleted: f[9] === "t" || f[9] === "true",
      pluginId: f[10] || null,
      legalEntityId: f[11] || null,
      integration: f[12] || null,
      pluginStatus: f[13] || null,
      isDefault: f[14] === "t" || f[14] === "true",
      pluginCountryCode: f[15],
      parentNumber: f[16],
      branchNumber: f[17],
      pluginProviderId: f[18] || null,
    });
  }
  return rows;
}

// legalEntityId -> Map(fieldKey -> value). `fields` is a jsonb array of {key, value},
// so it's unnested into one row per field; the country_code / type / business_type
// columns are unioned in as pseudo-keys so the comparison can reach them too.
//
// Copied unchanged from plugin_legal_entity_updates.js. Two things about it are
// load-bearing:
//
//   * THE CHILD ARM COMES LAST, so that on a key collision the child wins. A
//     pre-hierarchy `individual` root can carry a legacy `soleProprietorship.vatNumber`
//     (default.ex individual_legacy_fields), and the mapper reads the child's value.
//   * THE ID FILTER IS INSIDE BOTH ARMS. An unfiltered jsonb_array_elements over
//     legal_entities unnests 246k+ sole-proprietorship rows and hits the statement
//     timeout. Measured, not hypothetical — do not hoist it to an outer WHERE.
function fetchLegalEntityFields(env, legalEntityIds) {
  const map = new Map();
  if (!legalEntityIds.length) return map;

  for (const batch of chunked(legalEntityIds)) {
    const quoted = batch.map((id) => `'${guardUuid(id, "legal_entity_id")}'`).join(",");

    const sql =
      "SELECT le.id::text, f->>'key', coalesce(f->>'value', '')\n" +
      "FROM legal_entities le, jsonb_array_elements(le.fields) f\n" +
      `WHERE le.id IN (${quoted}) AND le.deleted_at IS NULL\n` +
      "UNION ALL\n" +
      "SELECT le.id::text, '_column.country_code', coalesce(le.country_code, '')\n" +
      "FROM legal_entities le\n" +
      `WHERE le.id IN (${quoted}) AND le.deleted_at IS NULL\n` +
      "UNION ALL\n" +
      "SELECT le.id::text, '_column.type', coalesce(le.type::text, '')\n" +
      "FROM legal_entities le\n" +
      `WHERE le.id IN (${quoted}) AND le.deleted_at IS NULL\n` +
      "UNION ALL\n" +
      "SELECT le.id::text, '_column.business_type', coalesce(le.business_type::text, '')\n" +
      "FROM legal_entities le\n" +
      `WHERE le.id IN (${quoted}) AND le.deleted_at IS NULL\n` +
      "UNION ALL\n" +
      "SELECT root.id::text, '_column.child_type', child.type::text\n" +
      "FROM legal_entities root\n" +
      "JOIN legal_entity_associations a ON a.root_legal_entity_id = root.id\n" +
      "  AND a.deleted_at IS NULL\n" +
      "JOIN legal_entities child ON child.id = a.associated_legal_entity_id\n" +
      "  AND child.deleted_at IS NULL\n" +
      `WHERE root.id IN (${quoted}) AND root.deleted_at IS NULL\n` +
      "UNION ALL\n" +
      "SELECT root.id::text, f->>'key', coalesce(f->>'value', '')\n" +
      "FROM legal_entities root\n" +
      "JOIN legal_entity_associations a ON a.root_legal_entity_id = root.id\n" +
      "  AND a.deleted_at IS NULL\n" +
      "JOIN legal_entities child ON child.id = a.associated_legal_entity_id\n" +
      "  AND child.deleted_at IS NULL,\n" +
      "     jsonb_array_elements(child.fields) f\n" +
      `WHERE root.id IN (${quoted}) AND root.deleted_at IS NULL;`;

    for (const [id, key, value] of parseRowsLoose(psqlRead(env, LE_DB, sql), 3)) {
      if (!map.has(id)) map.set(id, new Map());
      // Last writer wins — see the child-arm-last note above.
      map.get(id).set(key, value);
    }
  }

  // The map is keyed by id, but the comparison is handed only the inner map — so the
  // entity it read stays unnameable in the output unless the id travels inside it too.
  // The `_column.*` rows already guarantee an entry for every id that exists, so this
  // costs nothing.
  for (const [id, entityFields] of map) entityFields.set("_column.id", id);
  return map;
}

// First non-empty value among the candidate keys, and which key supplied it. The key
// matters in the detail table, where showing which side of the hierarchy answered
// (`soleProprietorship.vatNumber` on the child, not `organization.vatNumber` on the
// root) is the whole point.
function leValue(fields, keys) {
  if (!fields) return { value: "", key: "" };
  for (const key of keys) {
    const v = fields.get(key);
    if (v) return { value: v, key };
  }
  return { value: "", key: "" };
}

// When nothing matched there is still a key worth naming — the one this shape *would*
// use. An empty list means the shape has no slot and there is nothing honest to name.
function fallbackLeKey(keys) {
  return keys.length ? keys[0] : "";
}

// --- verdicts ----------------------------------------------------------------

const VERDICTS = {
  MATCH: "MATCH",
  PREFIX: "PREFIX",
  CONFLICT: "CONFLICT",
  LE_ONLY: "LE ONLY",
  CONFIG_ONLY: "CONFIG ONLY",
  NEITHER: "NEITHER",
  NO_SLOT: "NO SLOT",
};

// Verdicts that mean "the data is wrong" rather than "the data is shaped differently".
// PREFIX is excluded unless --include-prefix: it is equal under the application's own
// normalisation, so counting it would report 5 non-problems alongside 12 real ones.
function isFailing(verdict, opts) {
  if (verdict === VERDICTS.CONFLICT) return true;
  if (verdict === VERDICTS.PREFIX) return Boolean(opts.includePrefix);
  return false;
}

function colourVerdict(verdict) {
  switch (verdict) {
    case VERDICTS.MATCH:
      return c.ok(verdict);
    case VERDICTS.CONFLICT:
      return c.bad(verdict);
    case VERDICTS.PREFIX:
    case VERDICTS.LE_ONLY:
    case VERDICTS.CONFIG_ONLY:
      return c.warn(verdict);
    default:
      return c.faint(verdict);
  }
}

// Compare one plugin's accounting-documents values against its legal entity, field by
// field. `fields` is null when the plugin has no legal entity or the entity is gone —
// the caller has already classified that, so this is only reached with a live entity.
function compareFields(row, fields, opts) {
  const country = row.pluginCountryCode || row.configCountryCode;
  const entityType = fields.get("_column.type") || "";
  const businessType = fields.get("_column.business_type") || "";
  const shape = shapeFor(businessType, entityType);

  const results = [];

  for (const spec of FIELD_COMPARISON) {
    const keys = leKeysFor(shape, spec);
    const adValue = row[spec.ad] || "";
    const { value: leVal, key: leKey } = leValue(fields, keys);

    const rule = formatRuleFor(country, spec.formatField);
    const adBadFormat = Boolean(rule && adValue && !rule.test(adValue));
    const leBadFormat = Boolean(rule && leVal && !rule.test(leVal));

    let verdict;
    let subtype = null;
    let note = "";

    if (!keys.length) {
      // The shape has no slot at all. Not a discrepancy — an individual_trust emits no
      // identifiers, so there is nowhere for this value to live.
      verdict = VERDICTS.NO_SLOT;
      note = `a ${shape.key} entity has no slot for this — the invoice projection emits nothing here`;
    } else if (!adValue && !leVal) {
      verdict = VERDICTS.NEITHER;
    } else if (!leVal) {
      verdict = VERDICTS.CONFIG_ONLY;
      note = "missing in legal entity";
    } else if (!adValue) {
      verdict = VERDICTS.LE_ONLY;
      note = "missing in accounting-documents";
    } else if (normalizeValue(adValue) === normalizeValue(leVal)) {
      verdict = VERDICTS.MATCH;
      if (adValue !== leVal) note = "same value, different case";
    } else if (spec.prefixable && prefixEquivalent(adValue, leVal, country)) {
      verdict = VERDICTS.PREFIX;
      note = "same tax number, differs only by the ISO country prefix (tax_id_variants/2 treats these as equal)";
    } else {
      verdict = VERDICTS.CONFLICT;
      // Which side is malformed IS the finding. A corrupt column against a well-formed
      // entity is a data-quality bug with an obvious fix; two well-formed values naming
      // different numbers is a question for a human.
      if (adBadFormat && !leBadFormat) {
        subtype = "CONFIG MALFORMED";
        note = `accounting-documents value is invalid — ${rule.expected}; the legal entity's is well-formed`;
      } else if (leBadFormat && !adBadFormat) {
        subtype = "LE MALFORMED";
        note = `legal entity value is invalid — ${rule.expected}; accounting-documents' is well-formed`;
      } else if (adBadFormat && leBadFormat) {
        subtype = "BOTH MALFORMED";
        note = `neither side is valid — ${rule.expected}`;
      } else {
        subtype = "BOTH VALID";
        note = rule
          ? "both sides are well-formed but name a different value — needs a human"
          : "different values";
      }
    }

    results.push({
      field: spec.key,
      label: spec.label,
      adSource: spec.adSource,
      ad: adValue,
      le: leVal,
      // Always the key this shape would actually use — never an organization key against
      // an individual entity, which reads as a wrong lookup rather than a missing value.
      leKey: leKey || fallbackLeKey(keys),
      leKeys: keys,
      verdict,
      subtype,
      note,
      adBadFormat,
      leBadFormat,
      expectedFormat: rule ? rule.expected : null,
      failing: isFailing(verdict, opts),
    });
  }

  return { shape, results };
}

// --- classification ----------------------------------------------------------
//
// Before any field can be compared, the (configuration, plugin) pair has to be one that
// SHOULD have a legal entity. Three cases must not be counted as drift:
//
//   FRESHA ENTITY  an invoice_entity_id-keyed configuration. Fresha's own B2B issuer has
//                  no legal entity BY DESIGN — comarch/billing_details_policy.ex
//                  short-circuits `party_type: :fresha` and takes the CRN off the
//                  configuration. Flagging it would be wrong.
//   NO PLUGIN      a configuration with no plugin row at all.
//   UNLINKED       a provider-side plugin with legal_entity_id IS NULL. This one IS a
//                  finding — every integration's BillingDetailsPolicy returns
//                  {:error, :missing_legal_entity_id} and drops the sale — but there is
//                  nothing to compare it against, so it is counted separately and its
//                  plugin_status is reported: an `enabled` one is losing live sales,
//                  a `failed` one already stopped.
const STATES = {
  COMPARED: "COMPARED",
  UNLINKED: "UNLINKED",
  LE_MISSING: "LE MISSING",
  NO_PLUGIN: "NO PLUGIN",
  FRESHA_ENTITY: "FRESHA ENTITY",
};

function classify(row, leFields) {
  if (!row.providerId) return STATES.FRESHA_ENTITY;
  if (!row.pluginId) return STATES.NO_PLUGIN;
  if (!row.legalEntityId) return STATES.UNLINKED;
  if (!leFields.has(row.legalEntityId)) return STATES.LE_MISSING;
  return STATES.COMPARED;
}

// --- internal consistency ----------------------------------------------------
//
// The accounting-documents side against itself, with no legal entity involved. These are
// the invariants the service's own pre_flight_check/0 helpers assert
// (backfill_accounting_document_plugin_id_action.ex, backfill_tax_entity_data_task.ex),
// restated here so one run answers both questions.
function internalChecks(row) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add(
    "tax_id == vat_number",
    row.taxId === row.vatNumber,
    `tax_id=${row.taxId || DASH} vat_number=${row.vatNumber || DASH}`
  );

  if (row.pluginId) {
    add(
      "tax_id == plugin.parent_number",
      row.taxId === row.parentNumber,
      `tax_id=${row.taxId || DASH} parent_number=${row.parentNumber || DASH}`
    );

    add(
      "country_code == plugin.country_code",
      row.configCountryCode === row.pluginCountryCode,
      `config=${row.configCountryCode || DASH} plugin=${row.pluginCountryCode || DASH}`
    );

    // Only for default plugins. A BRANCH plugin is expected to carry a different CRN —
    // that is the entire point of it, and asserting equality here is what produced a
    // false positive for provider 1135636's plugin 402 on the first pass.
    if (row.isDefault) {
      add(
        "crn == plugin.branch_number",
        row.companyRegistrationNumber === row.branchNumber,
        `crn=${row.companyRegistrationNumber || DASH} branch_number=${row.branchNumber || DASH}`
      );
    } else {
      checks.push({
        name: "crn == plugin.branch_number",
        ok: true,
        skipped: true,
        detail: `branch plugin (is_default=false) — branch_number=${row.branchNumber || DASH} is expected to differ from the account CRN`,
      });
    }

    // 114 production plugins carry NULL here, which is a backfill gap rather than drift,
    // so only a POPULATED mismatch is a failure.
    if (row.pluginProviderId) {
      add(
        "provider_id == plugin.provider_id",
        row.providerId === row.pluginProviderId,
        `config=${row.providerId} plugin=${row.pluginProviderId}`
      );
    }
  }

  return checks;
}

// The `unique_tax_entity_per_plugin` partial index promises at most one ENABLED plugin
// per (country_code, parent_number, branch_number). Checked across the whole result set
// rather than per row, since that is the only level at which it means anything.
function duplicateTaxEntities(rows) {
  const seen = new Map();
  for (const row of rows) {
    if (!row.pluginId || row.pluginStatus !== "enabled") continue;
    const key = `${row.pluginCountryCode}|${row.parentNumber}|${row.branchNumber}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(row);
  }
  return [...seen.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({ key, plugins: group.map((r) => r.pluginId) }));
}

// --- analysis ----------------------------------------------------------------

function analyse(rows, leFields, opts) {
  const analysed = rows.map((row) => {
    const state = classify(row, leFields);
    const comparison =
      state === STATES.COMPARED ? compareFields(row, leFields.get(row.legalEntityId), opts) : null;

    const checks = internalChecks(row);

    return {
      row,
      state,
      shape: comparison ? comparison.shape : null,
      fields: comparison ? comparison.results : [],
      checks,
      checkFailures: checks.filter((ch) => !ch.ok),
      // A row "fails" if any compared field is failing, the legal entity it names is
      // gone, or it breaks one of the service's own internal invariants.
      failing:
        state === STATES.LE_MISSING ||
        checks.some((ch) => !ch.ok) ||
        (comparison ? comparison.results.some((f) => f.failing) : false),
    };
  });

  return { analysed, duplicates: duplicateTaxEntities(rows) };
}

function tally(analysed) {
  // Per country, per field, per verdict — plus the states that never reach a comparison.
  const byCountry = new Map();

  const bucket = (country) => {
    if (!byCountry.has(country)) {
      byCountry.set(country, {
        country,
        total: 0,
        states: {},
        fields: Object.fromEntries(FIELD_COMPARISON.map((s) => [s.key, {}])),
        conflictSubtypes: {},
      });
    }
    return byCountry.get(country);
  };

  for (const a of analysed) {
    const b = bucket(a.row.configCountryCode || "??");
    b.total += 1;
    b.states[a.state] = (b.states[a.state] || 0) + 1;

    for (const f of a.fields) {
      b.fields[f.field][f.verdict] = (b.fields[f.field][f.verdict] || 0) + 1;
      if (f.subtype) {
        b.conflictSubtypes[f.subtype] = (b.conflictSubtypes[f.subtype] || 0) + 1;
      }
    }
  }

  return [...byCountry.values()].sort((x, y) => y.total - x.total);
}

// --- rendering ---------------------------------------------------------------

// Fixed-width table. Kept deliberately plain so it survives copy-paste into a ticket or
// a Slack snippet.
function renderTable(headers, rows) {
  // Measure what the eye sees, not what the string holds: a coloured cell carries escape
  // bytes that padEnd would otherwise count as width.
  const visible = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
  const width = (s) => visible(s).length;
  const pad = (s, w) => String(s) + " ".repeat(Math.max(0, w - width(s)));

  const widths = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]))));
  const line = (cells) => cells.map((cell, i) => pad(cell, widths[i])).join("  ").trimEnd();

  return [line(headers), widths.map((w) => "─".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

// ONE column definition, three renderings. The terminal table, the Markdown and the CSV
// all come from here, so they cannot drift apart — and all three are built from the row
// objects, never from the rendered output, which carries ANSI escapes and padding.
const MATRIX_HEADERS = [
  "CONFIG",
  "PROVIDER",
  "PLUGIN",
  "CC",
  "INTEGRATION",
  "STATUS",
  "STATE",
  "TAX NO.",
  "REG NO.",
  "COUNTRY",
];

function verdictOf(a, field) {
  const f = a.fields.find((x) => x.field === field);
  if (!f) return DASH;
  return f.subtype ? `${f.verdict}/${f.subtype}` : f.verdict;
}

function matrixCells(a) {
  return [
    a.row.configId,
    a.row.providerId || DASH,
    a.row.pluginId || DASH,
    a.row.configCountryCode,
    a.row.integration || DASH,
    a.row.pluginStatus || DASH,
    a.state,
    verdictOf(a, "tax_number"),
    verdictOf(a, "registration_number"),
    verdictOf(a, "country"),
  ];
}

function matrixCellsColoured(a) {
  const cells = matrixCells(a);
  for (const i of [7, 8, 9]) {
    if (cells[i] === DASH) continue;
    const [verdict] = cells[i].split("/");
    cells[i] = colourVerdict(verdict) + (cells[i].includes("/") ? c.faint(cells[i].slice(verdict.length)) : "");
  }
  return cells;
}

function printMatrix(analysed, opts) {
  // Same filter as the Detail section, so the two can never disagree about what counts
  // as worth looking at.
  const shown = opts.conflictsOnly ? analysed.filter(isInteresting) : analysed;

  console.log(c.head("\n── Configurations ──────────────────────────────────────"));
  if (!shown.length) {
    console.log(c.ok("  Nothing to show."));
    return;
  }
  console.log(renderTable(MATRIX_HEADERS, shown.map(matrixCellsColoured)));
  if (opts.conflictsOnly && shown.length !== analysed.length) {
    console.log(c.faint(`\n  ${analysed.length - shown.length} clean row(s) hidden by --conflicts-only.`));
  }
}

function printTally(counts) {
  console.log(c.head("\n── Verdicts by country ─────────────────────────────────"));

  for (const spec of FIELD_COMPARISON) {
    const verdicts = [...new Set(counts.flatMap((b) => Object.keys(b.fields[spec.key])))];
    if (!verdicts.length) continue;

    const headers = ["COUNTRY", ...verdicts];
    const rows = counts.map((b) => [
      b.country,
      ...verdicts.map((v) => {
        const n = b.fields[spec.key][v] || 0;
        if (!n) return c.faint("0");
        return v === VERDICTS.CONFLICT ? c.bad(String(n)) : v === VERDICTS.MATCH ? c.ok(String(n)) : String(n);
      }),
    ]);

    console.log(`\n  ${c.head(spec.label)}  ${c.faint(`(${spec.adSource} vs the legal entity)`)}`);
    console.log(renderTable(headers, rows).split("\n").map((l) => `  ${l}`).join("\n"));
  }

  const states = [...new Set(counts.flatMap((b) => Object.keys(b.states)))];
  console.log(`\n  ${c.head("Rows by state")}`);
  console.log(
    renderTable(
      ["COUNTRY", "TOTAL", ...states],
      counts.map((b) => [b.country, String(b.total), ...states.map((s) => String(b.states[s] || 0))])
    )
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n")
  );

  const subtypes = {};
  for (const b of counts) {
    for (const [k, n] of Object.entries(b.conflictSubtypes)) subtypes[k] = (subtypes[k] || 0) + n;
  }
  if (Object.keys(subtypes).length) {
    console.log(`\n  ${c.head("Conflicts by kind")}`);
    console.log(
      renderTable(
        ["KIND", "N", "MEANS"],
        Object.entries(subtypes)
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => [k, String(n), CONFLICT_MEANINGS[k] || ""])
      )
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")
    );
  }
}

const CONFLICT_MEANINGS = {
  "CONFIG MALFORMED": "the column is corrupt; the legal entity is right",
  "LE MALFORMED": "the legal entity is corrupt; the column is right",
  "BOTH MALFORMED": "neither side is usable",
  "BOTH VALID": "two well-formed values naming different things — needs a human",
};

// Verdicts that need no explanation: the values agree, or there was nothing to compare
// and the shape says so. Everything else earns a detail entry — including PREFIX and
// LE ONLY, which are not failures but are still something a reader wants to see rather
// than infer from a tally.
const QUIET_VERDICTS = new Set([VERDICTS.MATCH, VERDICTS.NEITHER, VERDICTS.NO_SLOT]);

function isInteresting(a) {
  if (a.state !== STATES.COMPARED) return true;
  if (a.checkFailures.length) return true;
  return a.fields.some((f) => !QUIET_VERDICTS.has(f.verdict));
}

function printDetail(analysed) {
  const interesting = analysed.filter(isInteresting);

  console.log(c.head("\n── Detail ──────────────────────────────────────────────"));
  if (!interesting.length) {
    console.log(c.ok("  Nothing to report — every row compared cleanly."));
    return;
  }

  for (const a of interesting) {
    const r = a.row;
    const head =
      `config ${r.configId}  provider ${r.providerId || DASH}  plugin ${r.pluginId || DASH}  ` +
      `${r.configCountryCode}  ${r.integration || DASH}/${r.pluginStatus || DASH}`;
    console.log(`\n  ${c.head(head)}`);
    console.log(`    ${c.faint(`state: ${a.state}`)}`);

    if (a.state === STATES.UNLINKED) {
      const severity =
        r.pluginStatus === "enabled"
          ? c.bad("ENABLED with no legal entity — every send is refused with {:error, :missing_legal_entity_id}")
          : c.warn(`no legal entity, plugin_status=${r.pluginStatus} — already not sending`);
      console.log(`    ${severity}`);
    } else if (a.state === STATES.NO_PLUGIN) {
      console.log(`    ${c.warn("configuration has no plugin row at all")}`);
    } else if (a.state === STATES.LE_MISSING) {
      console.log(`    ${c.bad(`legal_entity_id ${r.legalEntityId} has no live row in ${LE_DB}`)}`);
    }

    if (a.shape) {
      console.log(
        `    ${c.faint(`legal entity ${r.legalEntityId}  shape: ${a.shape.key}${a.shape.legacy ? " (legacy guess)" : ""}`)}`
      );
    }

    const bad = a.fields.filter((f) => f.verdict !== VERDICTS.MATCH && f.verdict !== VERDICTS.NEITHER);
    if (bad.length) {
      console.log(
        renderTable(
          ["FIELD", "VERDICT", "ACCOUNTING-DOCUMENTS", "LEGAL ENTITY", "LE KEY", "NOTE"],
          bad.map((f) => [
            f.label,
            colourVerdict(f.verdict) + (f.subtype ? c.faint(`/${f.subtype}`) : ""),
            f.ad || DASH,
            f.le || DASH,
            f.leKey || DASH,
            f.note,
          ])
        )
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n")
      );
    }

    for (const ch of a.checkFailures) {
      console.log(`    ${c.bad(`internal: ${ch.name} FAILED`)} ${c.faint(ch.detail)}`);
    }
  }
}

function printInternal(analysed, duplicates) {
  const failures = analysed.flatMap((a) =>
    a.checkFailures.map((ch) => [a.row.configId, a.row.pluginId || DASH, ch.name, ch.detail])
  );

  console.log(c.head("\n── Internal consistency (accounting-documents only) ────"));
  console.log(
    c.faint("  The invariants the service's own pre_flight_check/0 helpers assert. No legal entity involved.")
  );

  if (failures.length) {
    console.log(
      renderTable(["CONFIG", "PLUGIN", "CHECK", "DETAIL"], failures)
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")
    );
  } else {
    console.log(`  ${c.ok("All checks pass.")}`);
  }

  const branchPlugins = analysed.filter((a) => a.row.pluginId && !a.row.isDefault);
  if (branchPlugins.length) {
    console.log(
      `\n  ${c.faint(`${branchPlugins.length} branch plugin(s) (is_default=false) exempted from the CRN check — a branch carries its own CRN by design:`)}`
    );
    for (const a of branchPlugins) {
      console.log(
        `    ${c.faint(`plugin ${a.row.pluginId} (config ${a.row.configId}, provider ${a.row.providerId}) branch_number=${a.row.branchNumber || DASH} vs account CRN ${a.row.companyRegistrationNumber || DASH}`)}`
      );
    }
  }

  if (duplicates.length) {
    console.log(`\n  ${c.bad("unique_tax_entity_per_plugin violated — more than one ENABLED plugin per (country, parent, branch):")}`);
    for (const d of duplicates) {
      console.log(`    ${c.bad(d.key)} → plugins ${d.plugins.join(", ")}`);
    }
  }
}

// --- markdown ----------------------------------------------------------------

function mdCell(value, emptyAs = DASH) {
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

function outputPath(namespace, extension) {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(process.cwd(), `account-config-le-audit-${namespace}-${day}.${extension}`);
}

function buildMarkdown(opts, env, analysed, counts, duplicates, summary) {
  const out = [];
  out.push("# account_configurations ↔ legal entity audit", "");
  out.push(`- Generated: ${new Date().toISOString()}`);
  out.push(`- Namespace: \`${opts.namespace}\`, psql env: \`${env}\``);
  out.push(`- Databases: \`${AD_DB}\` + \`${LE_DB}\` (read-only)`);
  if (opts.countries.length) out.push(`- Country filter: ${opts.countries.join(", ")}`);
  if (opts.providers.length) out.push(`- Provider filter: ${opts.providers.join(", ")}`);
  out.push("");

  out.push("## Summary", "");
  out.push(
    mdTable(
      ["Metric", "Value"],
      [
        ["Rows examined", summary.total],
        ["Compared", summary.states[STATES.COMPARED] || 0],
        ["Unlinked (no legal_entity_id)", summary.states[STATES.UNLINKED] || 0],
        ["…of those, enabled", summary.unlinkedEnabled],
        ["Legal entity missing", summary.states[STATES.LE_MISSING] || 0],
        ["No plugin", summary.states[STATES.NO_PLUGIN] || 0],
        ["Fresha entity (excluded by design)", summary.states[STATES.FRESHA_ENTITY] || 0],
        ["Conflicting fields", summary.conflicts],
        ["Internal-consistency failures", summary.checkFailures],
        ["Verdict", summary.verdict],
      ]
    )
  );
  out.push("");

  out.push("## Verdicts by country", "");
  for (const spec of FIELD_COMPARISON) {
    const verdicts = [...new Set(counts.flatMap((b) => Object.keys(b.fields[spec.key])))];
    if (!verdicts.length) continue;
    out.push(`### ${spec.label} — \`${spec.adSource}\` vs the legal entity`, "");
    out.push(
      mdTable(
        ["Country", ...verdicts],
        counts.map((b) => [b.country, ...verdicts.map((v) => String(b.fields[spec.key][v] || 0))])
      )
    );
    out.push("");
  }

  const subtypes = {};
  for (const b of counts) {
    for (const [k, n] of Object.entries(b.conflictSubtypes)) subtypes[k] = (subtypes[k] || 0) + n;
  }
  if (Object.keys(subtypes).length) {
    out.push("### Conflicts by kind", "");
    out.push(
      mdTable(
        ["Kind", "N", "Means"],
        Object.entries(subtypes)
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => [k, String(n), CONFLICT_MEANINGS[k] || ""])
      )
    );
    out.push("");
  }

  out.push("## All rows", "");
  out.push(mdTable(MATRIX_HEADERS, analysed.map(matrixCells)));
  out.push("");

  const interesting = analysed.filter(isInteresting);
  if (interesting.length) {
    out.push("## Detail", "");
    for (const a of interesting) {
      const r = a.row;
      out.push(
        `### config ${r.configId} · provider ${r.providerId || DASH} · plugin ${r.pluginId || DASH} (${r.configCountryCode})`,
        ""
      );
      out.push(`- State: \`${a.state}\``);
      out.push(`- Integration: \`${r.integration || DASH}\`, status: \`${r.pluginStatus || DASH}\`, is_default: \`${r.isDefault}\``);
      if (r.legalEntityId) out.push(`- Legal entity: \`${r.legalEntityId}\``);
      if (a.shape) out.push(`- Shape: \`${a.shape.key}\`${a.shape.legacy ? " (legacy guess)" : ""}`);
      out.push("");

      const bad = a.fields.filter((f) => f.verdict !== VERDICTS.MATCH && f.verdict !== VERDICTS.NEITHER);
      if (bad.length) {
        out.push(
          mdTable(
            ["Field", "Verdict", "accounting-documents", "Legal entity", "LE key", "Note"],
            bad.map((f) => [
              f.label,
              f.subtype ? `${f.verdict} / ${f.subtype}` : f.verdict,
              f.ad,
              f.le,
              f.leKey ? `\`${f.leKey}\`` : "",
              f.note,
            ])
          )
        );
        out.push("");
      }
      for (const ch of a.checkFailures) {
        out.push(`- **internal check failed:** \`${ch.name}\` — ${ch.detail}`);
      }
      if (a.checkFailures.length) out.push("");
    }
  }

  out.push("## Internal consistency", "");
  const failures = analysed.flatMap((a) =>
    a.checkFailures.map((ch) => [a.row.configId, a.row.pluginId || DASH, ch.name, ch.detail])
  );
  out.push(
    failures.length
      ? mdTable(["Config", "Plugin", "Check", "Detail"], failures)
      : "All checks pass."
  );
  out.push("");

  if (duplicates.length) {
    out.push("### `unique_tax_entity_per_plugin` violations", "");
    out.push(mdTable(["country|parent|branch", "Plugins"], duplicates.map((d) => [d.key, d.plugins.join(", ")])));
    out.push("");
  }

  out.push("## Notes", "");
  out.push(
    "- The comparison is **plugin-level**: `plugins.parent_number` / `.branch_number` / `.country_code`",
    "  against the legal entity the plugin itself points at. A branch plugin (`is_default = false`)",
    "  carries its own CRN by design, so comparing `account_configurations.company_registration_number`",
    "  would invent a conflict for it.",
    "- `PREFIX` means the two sides are equal under the application's own `tax_id_variants/2`",
    "  normalisation and differ only by the leading ISO country code. Not a discrepancy.",
    "- `configuration` (always `{}`), `enabled` (dead) and `vat_number` (a duplicate of `tax_id`)",
    "  are not compared. See the script header.",
    "- Fresha-issued (`invoice_entity_id`) configurations have no legal entity by design and are",
    "  excluded from every tally."
  );
  out.push("");

  return out.join("\n");
}

// --- CSV ---------------------------------------------------------------------
//
// RFC 4180: a field holding a comma, a double quote or a newline is quoted, and any
// quote inside it is doubled.

function csvCell(value) {
  // The em-dash is a display convention for "nothing". A spreadsheet wants an empty cell
  // instead, so it sorts and filters as absent rather than as text.
  const s = value === null || value === undefined || value === DASH ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(namespace, analysed) {
  const file = outputPath(namespace, "csv");
  const lines = [MATRIX_HEADERS, ...analysed.map(matrixCells)].map((cells) =>
    cells.map(csvCell).join(",")
  );
  // Trailing newline: POSIX text file, and it stops the last row being flagged as
  // truncated by anything strict.
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

// --- CLI ---------------------------------------------------------------------

const USAGE = `
account_config_legal_entity_audit — where has a provider's tax identity drifted away
from its legal entity?

Walks every account_configuration in accounting_documents, follows each of its plugins
to the legal entity that plugin points at in legal_entities, and reports a verdict per
field. READ-ONLY: there is no write path in this file.

Usage: ./account_config_legal_entity_audit.js [flags]

  -n, --namespace NAME   namespace / psql env (default: ${DEFAULT_NAMESPACE})
      --country XX       only this country; repeatable (SA, ES, IT)
      --provider ID      only this provider_id; repeatable, or comma-separated
      --conflicts-only   hide rows that compared cleanly. Affects the TERMINAL view
                         only — the Markdown and CSV always carry every row, so an
                         export is never a filtered subset you can mistake for the whole
                         picture.
      --include-prefix   count PREFIX as a conflict. Off by default: a PREFIX row is
                         equal under the application's own tax_id_variants/2, so
                         counting it buries the real conflicts.
      --md [PATH]        write the Markdown report (default: always written)
      --no-md            don't write the Markdown report
      --csv / --no-csv   write the CSV, or don't — either way no prompt
      --json             one result document on stdout, every human line on stderr
  -y, --yes              approve the reads without a terminal
  -h, --help             this

Compared, per plugin:
  plugins.parent_number   vs  <shape>.vatNumber            (IDENTIFIER_KIND_TAX_NUMBER)
  plugins.branch_number   vs  <shape>.registrationNumber
  plugins.country_code    vs  _column.country_code

NOT compared, and why: account_configurations.configuration is {} on every production
row and read nowhere; .enabled is dead (not in the Ecto schema); .vat_number is a
write-only duplicate of .tax_id, asserted equal instead.

Verdicts: MATCH, PREFIX (differs only by the ISO country prefix — not a discrepancy),
CONFLICT (sub-labelled CONFIG MALFORMED / LE MALFORMED / BOTH MALFORMED / BOTH VALID),
LE ONLY, CONFIG ONLY, NEITHER, NO SLOT.
States: COMPARED, UNLINKED (no legal_entity_id — every send is refused), LE MISSING,
NO PLUGIN, FRESHA ENTITY (no legal entity by design; excluded).

Exit: 0 clean, ${EXIT_DATA} the data is wrong, ${EXIT_USAGE} the call was wrong or approval refused.

Examples:
  ./account_config_legal_entity_audit.js                       # interactive
  ./account_config_legal_entity_audit.js --yes --md            # full production audit
  ./account_config_legal_entity_audit.js --country IT --yes
  ./account_config_legal_entity_audit.js --provider 1135636 --yes
  ./account_config_legal_entity_audit.js --json --yes | jq .summary
`;

function parseArgs(argv) {
  const opts = {
    namespace: DEFAULT_NAMESPACE,
    namespaceGiven: false,
    countries: [],
    providers: [],
    conflictsOnly: false,
    includePrefix: false,
    md: true,
    mdPath: null,
    csv: null, // null = ask
    json: false,
    yes: false,
  };

  const next = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("-")) throw new UsageError(`${flag} needs a value.`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        return { help: true };
      case "-n":
      case "--namespace":
        opts.namespace = next(i, a);
        opts.namespaceGiven = true;
        i++;
        break;
      case "--country":
        opts.countries.push(guardCountry(next(i, a)));
        i++;
        break;
      case "--provider":
        for (const id of next(i, a).split(/[,\s]+/).filter(Boolean)) {
          opts.providers.push(guardInt(id, "--provider"));
        }
        i++;
        break;
      case "--conflicts-only":
        opts.conflictsOnly = true;
        break;
      case "--include-prefix":
        opts.includePrefix = true;
        break;
      case "--md":
        opts.md = true;
        // Optional value: --md alone means "the default path".
        if (argv[i + 1] && !argv[i + 1].startsWith("-")) {
          opts.mdPath = argv[i + 1];
          i++;
        }
        break;
      case "--no-md":
        opts.md = false;
        break;
      case "--csv":
        opts.csv = true;
        break;
      case "--no-csv":
        opts.csv = false;
        break;
      case "--json":
        opts.json = true;
        break;
      case "-y":
      case "--yes":
        opts.yes = true;
        break;
      default:
        throw new UsageError(`Unknown argument: ${a}\nRun with --help for the flags.`);
    }
  }

  opts.countries = [...new Set(opts.countries)];
  opts.providers = [...new Set(opts.providers)];
  return opts;
}

async function askNamespace() {
  return askChoice("WHICH NAMESPACE?", [
    { label: "production", value: "production", aliases: ["production", "prod"], default: true },
    { label: "eng-orion (staging)", value: "eng-orion", aliases: ["eng-orion", "staging"] },
    { label: "something else — type it", value: "__other__", aliases: ["other"] },
  ]).then(async (v) => {
    if (v !== "__other__") return v;
    const raw = (await ask("  namespace: ")).trim();
    if (!raw) throw new UsageError("No namespace given.");
    return raw;
  });
}

// The read gate. Named before anything runs, because "which database am I about to
// read" is not a question anyone should have to answer by reading the source.
async function confirmDataAccess(opts, env) {
  const prod = isProd(opts.namespace);

  promptStream.write(`\n${c.head("── About to read real data ─────────────────────────────")}\n`);
  promptStream.write(`  namespace : ${opts.namespace}${prod ? c.warn("   ⚠  PRODUCTION") : ""}\n`);
  promptStream.write(`  psql env  : ${env}\n`);
  promptStream.write(`  databases : ${AD_DB}, ${LE_DB}\n`);
  promptStream.write("  access    : SELECT only — this script has no write path\n");
  if (opts.countries.length) promptStream.write(`  countries : ${opts.countries.join(", ")}\n`);
  if (opts.providers.length) promptStream.write(`  providers : ${opts.providers.join(", ")}\n`);

  // --yes IS the approval for the reads. Legitimate here in a way it would not be for a
  // write: this script cannot write, so there is no stronger action it could unlock.
  if (opts.yes) {
    promptStream.write(`  ${c.faint("--yes given — proceeding.")}\n`);
    return true;
  }

  if (!input.isTTY) {
    throw new UsageError(
      "No terminal to ask for read approval on. Pass --yes to approve the reads " +
        "(this script is read-only, so --yes cannot unlock a write)."
    );
  }

  // In production a bare Enter CANCELS.
  return askChoice("Read from these databases?", [
    { label: "Yes — run the reads", value: true, aliases: ["y", "yes"], default: !prod },
    { label: "Cancel — nothing is read", value: false, aliases: ["n", "no"], default: prod },
  ]);
}

// --- main --------------------------------------------------------------------

async function run(opts) {
  const env = psqlEnv(opts.namespace);

  if (!(await confirmDataAccess(opts, env))) {
    console.error("Cancelled — nothing was read.");
    return EXIT_USAGE;
  }

  console.log(c.faint("\nReading account configurations…"));
  let rows = fetchConfigurations(env);
  const totalRows = rows.length;

  if (opts.countries.length) {
    rows = rows.filter((r) => opts.countries.includes(String(r.configCountryCode).toUpperCase()));
  }
  if (opts.providers.length) {
    rows = rows.filter((r) => opts.providers.includes(r.providerId));
  }

  if (!rows.length) {
    console.error(
      c.warn(`\nNo configurations matched (${totalRows} row(s) read before filtering).`)
    );
    return EXIT_USAGE;
  }
  if (rows.length !== totalRows) {
    console.log(c.faint(`  ${rows.length} of ${totalRows} row(s) after filtering.`));
  }

  const legalEntityIds = [...new Set(rows.map((r) => r.legalEntityId).filter(Boolean))];
  console.log(c.faint(`\nReading ${legalEntityIds.length} legal entit${legalEntityIds.length === 1 ? "y" : "ies"}…`));
  const leFields = fetchLegalEntityFields(env, legalEntityIds);

  const { analysed, duplicates } = analyse(rows, leFields, opts);

  const states = {};
  for (const a of analysed) states[a.state] = (states[a.state] || 0) + 1;

  const conflicts = analysed.reduce((n, a) => n + a.fields.filter((f) => f.failing).length, 0);
  const checkFailures = analysed.reduce((n, a) => n + a.checkFailures.length, 0);
  const leMissing = states[STATES.LE_MISSING] || 0;
  const unlinkedEnabled = analysed.filter(
    (a) => a.state === STATES.UNLINKED && a.row.pluginStatus === "enabled"
  ).length;

  const failed = conflicts > 0 || checkFailures > 0 || leMissing > 0 || duplicates.length > 0;

  const summary = {
    total: analysed.length,
    rows_read: totalRows,
    states,
    conflicts,
    checkFailures,
    unlinkedEnabled,
    duplicates: duplicates.length,
    verdict: failed ? "FAIL" : "PASS",
  };

  const counts = tally(analysed);

  printMatrix(analysed, opts);
  printTally(counts);
  printDetail(analysed);
  printInternal(analysed, duplicates);

  console.log(c.head("\n── Summary ─────────────────────────────────────────────"));
  console.log(
    renderTable(
      ["METRIC", "VALUE"],
      [
        ["rows examined", String(summary.total)],
        ["compared", String(states[STATES.COMPARED] || 0)],
        ["unlinked (no legal_entity_id)", String(states[STATES.UNLINKED] || 0)],
        ["  …of those, enabled", unlinkedEnabled ? c.bad(String(unlinkedEnabled)) : c.ok("0")],
        ["legal entity missing", leMissing ? c.bad(String(leMissing)) : c.ok("0")],
        ["no plugin", String(states[STATES.NO_PLUGIN] || 0)],
        ["fresha entity (excluded by design)", String(states[STATES.FRESHA_ENTITY] || 0)],
        ["conflicting fields", conflicts ? c.bad(String(conflicts)) : c.ok("0")],
        ["internal-consistency failures", checkFailures ? c.bad(String(checkFailures)) : c.ok("0")],
        ["verdict", failed ? c.bad("FAIL") : c.ok("PASS")],
      ]
    )
  );

  if (opts.md) {
    const file = opts.mdPath || outputPath(opts.namespace, "md");
    fs.writeFileSync(file, buildMarkdown(opts, env, analysed, counts, duplicates, summary), "utf8");
    console.log(`\nReport written: ${c.cmd(file)}`);
  }

  let csvFile = null;
  if (opts.csv === true) {
    csvFile = writeCsv(opts.namespace, analysed);
    console.log(`CSV written:    ${c.cmd(csvFile)}`);
  } else if (opts.csv === null && !opts.json && input.isTTY) {
    const answer = (await askOptional("\nAlso write the same table as .csv? (y/N): ", "n"))
      .trim()
      .toLowerCase();
    if (answer === "y" || answer === "yes") {
      csvFile = writeCsv(opts.namespace, analysed);
      console.log(`CSV written:    ${c.cmd(csvFile)}`);
    }
  }

  const exitCode = failed ? EXIT_DATA : 0;

  if (opts.json) {
    // Called after the exit code is decided, so `exit` in the document can never
    // disagree with the process's own status.
    process.stdout.write(
      `${JSON.stringify(
        {
          schema_version: 1,
          namespace: opts.namespace,
          psql_env: env,
          databases: [AD_DB, LE_DB],
          filters: { countries: opts.countries, providers: opts.providers },
          exit: exitCode,
          summary,
          by_country: counts,
          duplicate_tax_entities: duplicates,
          rows: analysed.map((a) => ({
            config_id: a.row.configId,
            provider_id: a.row.providerId || null,
            invoice_entity_id: a.row.invoiceEntityId || null,
            plugin_id: a.row.pluginId,
            legal_entity_id: a.row.legalEntityId,
            country_code: a.row.configCountryCode,
            integration: a.row.integration,
            plugin_status: a.row.pluginStatus,
            is_default: a.row.isDefault,
            state: a.state,
            shape: a.shape ? a.shape.key : null,
            failing: a.failing,
            fields: a.fields.map((f) => ({
              field: f.field,
              accounting_documents: f.ad || null,
              accounting_documents_source: f.adSource,
              legal_entity: f.le || null,
              legal_entity_key: f.leKey || null,
              legal_entity_keys: f.leKeys,
              verdict: f.verdict,
              subtype: f.subtype,
              note: f.note || null,
              invalid_format:
                f.adBadFormat && f.leBadFormat
                  ? "both"
                  : f.adBadFormat
                    ? "accounting_documents"
                    : f.leBadFormat
                      ? "legal_entity"
                      : null,
              expected_format: f.expectedFormat,
              failing: f.failing,
            })),
            internal_checks: a.checks.map((ch) => ({
              name: ch.name,
              ok: ch.ok,
              skipped: Boolean(ch.skipped),
              detail: ch.detail,
            })),
          })),
          report: opts.md ? opts.mdPath || outputPath(opts.namespace, "md") : null,
          csv: csvFile,
        },
        null,
        2
      )}\n`
    );
  }

  return exitCode;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    output.write(USAGE);
    return 0;
  }

  if (opts.json) startJsonMode();

  if (!opts.namespaceGiven && input.isTTY && !opts.yes) {
    opts.namespace = await askNamespace();
  }

  return run(opts);
}

main()
  .then((code) => {
    closeRl();
    process.exit(code || 0);
  })
  .catch((err) => {
    closeRl();
    console.error(`\nError: ${err.message}`);
    process.exit(err.exitCode || EXIT_DATA);
  });
