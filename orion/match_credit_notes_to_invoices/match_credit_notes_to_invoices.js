#!/usr/bin/env node
//
// match_credit_notes_to_invoices — which invoice does each B2B credit note belong to?
//
// B2B (partner) billing documents live in two databases and are only loosely
// coupled:
//
//   shedul.provider_invoices        the source of truth for Fresha's periodic
//                                   partner billing. One row per document,
//                                   billing_document_type IN (invoice, credit_note).
//   accounting_documents.accounting_documents
//                                   the e-invoicing mirror — one row per document
//                                   reported to the tax authority (KSA / ZATCA).
//
// The problem this script solves: A CREDIT NOTE HAS NO POINTER TO ITS INVOICE.
// provider_invoices has no original_invoice_id / credit_note_id column. Positive
// fee items become an invoice and negative items become a credit note — see shedul's
// Areas::ProviderInvoicing::CreateProviderInvoiceService#handle_invoice_and_credit_note.
// That split is by SIGN, not by amount, and the two sides are different items, so a
// credit note can legitimately be worth more than its month's invoice (a `credit` item
// is an adjustment, not a reversal of that month's fees). 37 of 295 production credit
// notes exceed every invoice in their own period.
//
// ============================================================================
// THE LOGIC, QUERY BY QUERY
//
// Four queries, then the match in Node (a cross-database join is impossible). Each
// query supplies one piece of the reconstruction, and each carries at least one
// decision that is not the obvious one. What follows is those decisions and why they
// went the way they did.
//
// The SQL is not repeated here — every statement is echoed as it runs and written
// into the outputs (see "SQL executed" in the Markdown report, and the .sql file
// beside the decode CSV). ./cross-check.sql annotates the same five, and expresses
// the ranking below as a row_number() window.
//
// ---------------------------------------------------------------------------
// 1. accounting_documents — fetchSuppliedDocs(). Is the input the right kind of
//    thing, and what is its cross-database key?
//
//    You supply accounting_documents.id values. Two things must come out: proof
//    each is a B2B credit note, and einvoice_reference, which is the ONLY key that
//    reaches shedul.
//
//    The validation is two conditions and needs both. `document_type =
//    'credit_note'` alone is not enough — a B2C sale refund is also a credit note,
//    but it has a sale_id and no partner-billing counterpart, so shedul has nothing
//    to resolve it to. `einvoice_reference IS NOT NULL` is what separates partner
//    billing from sale refunds.
//
// ---------------------------------------------------------------------------
// 2. shedul — fetchShedulCreditNotes(). The provider, the period, and the credit
//    note's true value.
//
//    THE PROVIDER MUST COME FROM HERE. accounting_documents.provider_id is NULL on
//    B2B billing documents. Take it from query 1 and the candidate pool is empty.
//    Not a preference — the only source.
//
//    THE VALUE IS sum(provider_invoice_items.fee), NOT provider_invoices.total, and
//    this is the most important line in the file. `total` is wrong on 280 of 295
//    production credit notes: it carries the CO-CREATED INVOICE's total. So a match
//    that compared credit_note.total against invoice.total would be comparing an
//    invoice's total with a copy of itself — every match would look right and the
//    whole exercise would be circular, passing by construction.
//
//    Worked example, CN/1006: stored total 1224042, items sum -81606. 12240.42 is
//    exactly INV/16204's total.
//
// ---------------------------------------------------------------------------
// 3. shedul — fetchProviderInvoices(). The candidate pool. Three decisions, three
//    ways to be wrong.
//
//    NO BILLING-PERIOD FILTER. The obvious query restricts to the credit note's own
//    month and is wrong: 37 of 295 credit notes are worth more than every invoice
//    in their own period, because handle_invoice_and_credit_note splits by SIGN and
//    a `credit` item is an adjustment rather than a reversal of that month's fees —
//    nothing constrains the negatives to be smaller than the positives. CN/1044 is
//    2000.00 against an own-month invoice of 1165.13. Filter by period and those 37
//    come back unmatched.
//
//    einvoice_reference IS NOT NULL. Without it the pool gains the 1.8M pre-rollout
//    invoices and the 1.25M not_applicable non-KSA ones. Those are NOT failed
//    emissions — the check for "an e-invoicing provider's invoice, after the cutoff,
//    missing a reference" returns 0 — but pointing a ZATCA credit note at a document
//    ZATCA has never seen is not a useful answer. Costs 2 matches of 295.
//
//    NO einvoice_status FILTER, and this is the one people reach for. An earlier
//    version dropped `rejected`/`refunded` candidates and it was wrong: invoices and
//    their credit notes are created in the SAME TRANSACTION, 23-24 ms apart, and for
//    43 of 63 then-ambiguous credit notes the co-created invoice was the `refunded`
//    one — precisely the row the status rule discarded.
//
// ---------------------------------------------------------------------------
// 4. THE MATCH — pickInvoice(), in Node. Three hard constraints, then a ranking:
//
//      ELIGIBLE  1. einvoice_reference IS NOT NULL  (applied in query 3)
//                2. billing_end <= credit note's billing_end
//                3. total >= credit note value
//      RANK      closest first, going backwards: latest billing period, then latest
//                created_at within it, then highest id
//
//    (2) IS THE BILLING PERIOD, NOT created_at. Not interchangeable: a February
//    invoice is written on 2026-03-02, after February has ended, and its credit note
//    35 ms later in the same transaction. `created_at < billingStart` is therefore
//    false for EVERY own-period invoice and would discard the common case outright.
//    The period is the key; the timestamps only break ties within one.
//
//    A LATER invoice is INELIGIBLE, not a last resort — a document that did not exist
//    cannot be the one credited. A credit note whose only large-enough invoice is
//    later comes back UNMATCHED rather than citing it.
//
//    No separate "own period first" key is needed: with (2) in force the own period
//    has the greatest billing_end of any eligible invoice, so it sorts first by
//    construction.
//
//    (3) compares invoice.total AS STORED against the credit note's magnitude, so the
//    194 production invoices with negative totals never qualify. Intended. Both sides
//    are GROSS — `total` = subtotal + tax, and the credit note sums `fee`, which is
//    itself gross with `fee_tax` inside it.
//
//    There is deliberately NO AMBIGUOUS verdict: the ranking is a total order, so it
//    always resolves to one invoice or to none. UNMATCHED prints the largest ELIGIBLE
//    invoice beside it, plus the eligible and total counts — "none eligible" and "none
//    big enough" are different problems.
//
// ---------------------------------------------------------------------------
// 5. accounting_documents — fetchInvoiceTrackers(). The matched invoice's own
//    reference and ZATCA status.
//
//    receipt_number is read HERE rather than taken from shedul's invoice_reference
//    because it is the value a credit note's previous_receipt_number must carry, and
//    that field is consumed by the e-invoicing side. Both agree on all 34 — but
//    "they agree" is a fact about today's data, not a guarantee, and a divergence
//    would yield a valid-looking document citing an invoice number the tax authority
//    cannot resolve. A mismatch is reported, never assumed away.
//
// ---------------------------------------------------------------------------
// WHAT THE CHECKS DO AND DO NOT PROVE
//
//   SQL row_number()  34/34   transcription and ordering bugs in either
//                             implementation. NOT the rule — both encode the same one.
//   co-creation       29/34   whether the rule agrees with the code that created the
//                             rows. Unavailable for the 5 that differ, which is
//                             exactly where the answer is least obvious.
//   payload asserts   34/34   that the bytes are sound. NOT that the reference is right.
//   ZATCA's verdict           everything. The only one that settles it.
//
// THE HONEST WEAK POINT: the amount rule and the ranking are inferences chosen
// against production data, not consequences of a schema relationship. Nothing here
// can prove them. The strongest evidence is co-creation agreeing on 29 of 34 with
// all 5 divergences explained by the same documented mechanism.
//
// THE THINNEST RESULT IN THE COHORT is CN/1098: worth 278.00, its provider has no
// invoice at all in the credit note's month, and the nearest is 277.18 — short by
// 0.82. The match lands three months back on INV/18891. The rule working as
// specified, and the row to check by hand before writing anything.
// ============================================================================
//
// The other mode, `decode`, answers a different question — what is actually inside a
// document's payload_base64 — and lives in ./decode_payloads.js, which is a standalone
// executable this file requires. See its header; the short version is that payload_base64
// is an Erlang term, so reading one needs a BEAM, and the service's own checkout next door
// is where the nearest one is (`mix run --no-start`).
//
// SAFETY
//   - Lives under write/ because a mutating mode is planned. Both modes that exist
//     today, `matrix` and `decode`, are READ-ONLY: SELECTs only, and there is no
//     `houston psql --write` anywhere in either file. The only things they write are
//     the Markdown report and the CSVs, in the working directory.
//   - READ_ONLY_MODES governs that. Any mode not listed there refuses to run
//     without a TTY, in every namespace — so adding a write mode gates it by
//     default instead of by remembering to.
//   - Every statement is echoed before it runs.
//   - A confirmation gate before the first query; production defaults to Cancel.
//   - Every interpolated value is validated first (integers, uuids, dates).
//
// Usage:
//   ./match_credit_notes_to_invoices.js          fully interactive — it asks you everything
//   ./match_credit_notes_to_invoices.js --ids 4838124,4838004 --yes --csv     non-interactive
//
// Anything you pass is not prompted for; anything you leave out is. Supply --ids and
// --yes and it runs start to finish without a terminal, which is what a cron or a CI
// step needs. --yes approves the READS only, and only for read-only modes.
//
// Prereqs: VPN up, `houston` authenticated (prod reads use the
// fresha-production-developer profile). Node only, no dependencies.

"use strict";

const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// The `decode` mode lives in its own file: it decodes Erlang terms in the service's local
// BEAM and shares
// nothing with the matching logic here beyond the psql idiom. It is a standalone
// executable in its own right — this requires it rather than re-implementing it, so
// `--mode decode` and `./decode_payloads.js` run exactly the same code.
const decodePayloads = require("./decode_payloads");

// --- constants ---------------------------------------------------------------

// provider_invoices (the billing documents themselves) is owned by shedul; the
// e-invoicing mirror and its ZATCA trackers live in accounting_documents.
const SHEDUL_DB = "shedul";
const AD_DB = "accounting_documents";

const DEFAULT_NAMESPACE = "production";
const PROD_NAMESPACES = new Set(["production", "prod"]);

// An IN(...) list of a few thousand ids makes for an unwieldy statement and an
// unreadable echo. Split the reads instead; the results are merged in Node.
const CHUNK = 500;

// Modes that cannot mutate anything, and so may run without a terminal — piping
// answers in is how you re-run a check reproducibly. Every other mode refuses
// without a TTY, in every namespace: a piped "yes" is not explicit approval for a
// write. Both modes today are read-only; this lives here so that adding a write
// mode gates it by default rather than by remembering to.
const READ_ONLY_MODES = new Set(["matrix", "decode"]);

function writesAnything(mode) {
  return !READ_ONLY_MODES.has(mode);
}

const EXIT_DATA = 1; // something in the data is wrong or unresolved
const EXIT_USAGE = 2; // the call was wrong, or approval was refused

const MODES = ["matrix", "decode"];

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.exitCode = EXIT_USAGE;
  }
}

// --- arg parsing -------------------------------------------------------------
//
// Every value can also be prompted for. A flag's job is only to suppress its prompt,
// so the interactive and non-interactive paths run the same code afterwards — there
// is no second implementation to keep in step.

function usage() {
  console.log(`match_credit_notes_to_invoices — which invoice does each B2B credit note belong to?

Usage:
  ./match_credit_notes_to_invoices.js [options]

Modes:
  matrix   credit note -> the invoice it credits (default)
  decode   dump each document's decoded payload_base64 to CSV — see decode_payloads.js,
           which this mode calls and which also runs on its own

Options:
  -n, --namespace <ns>      deploy namespace (default ${DEFAULT_NAMESPACE})
      --ids <list>          accounting_documents.id values, comma or space separated
      --mode <mode>         ${MODES.join(" | ")} (default ${MODES[0]})
      --csv                 also write the CSV, without asking          (matrix)
      --no-csv              never write the CSV. matrix asks without it;
                            decode always writes unless you pass this.
      --app-dir <path>      app-accounting-documents checkout that decodes (decode)
      --task-service <svc>  deployment named in the emitted write command  (decode)
  -y, --yes                 approve the database reads without prompting.
                            Read-only modes only — it cannot approve a write.
  -h, --help                this text

Anything not passed is prompted for. For a fully non-interactive run supply --ids
and --yes (and --csv or --no-csv, or the CSV is simply skipped).

  ./match_credit_notes_to_invoices.js
  ./match_credit_notes_to_invoices.js --ids 4838124,4838004 --yes --csv
  ./match_credit_notes_to_invoices.js -n eng-orion --ids 123 --yes --no-csv
  ./match_credit_notes_to_invoices.js --mode decode --ids 4836650 --yes

matrix: the match is an E-INVOICED invoice of the same provider whose total is >= the
credit note's value, in ANY billing period. Among those, the credit note's own period
wins, then the most recent invoice created at or before it. The credit note's value is
the sum of its line items, not provider_invoices.total (unreliable on credit notes).

decode: payload_base64 is an Erlang term, so reading it needs a BEAM. The payloads are
read from --namespace and decoded locally in the app-accounting-documents checkout
(--app-dir) by 'mix run --no-start', which loads the modules and starts nothing.

Exit codes: 0 all resolved, 1 anything unresolved or rejected, 2 bad invocation.`);
}

function parseArgs(argv) {
  const opts = {
    namespace: DEFAULT_NAMESPACE,
    namespaceGiven: false,
    ids: null,
    mode: null,
    csv: null, // null = ask, true = write, false = skip
    // Only the decode mode uses these; its own defaults are the single source of truth,
    // so they are not restated here.
    app: decodePayloads.appDefaults(),
    yes: false,
  };

  // A flag that needs a value must actually have one: `--ids` at the end of the line
  // would otherwise silently consume nothing and fall through to the prompt.
  const value = (flag, i) => {
    if (i + 1 >= argv.length) throw new UsageError(`${flag} needs a value.`);
    return argv[i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        usage();
        process.exit(0);
        break;
      case "-n":
      case "--namespace":
        opts.namespace = value(arg, i++);
        opts.namespaceGiven = true;
        break;
      case "--ids":
        opts.ids = parseIds(value(arg, i++));
        break;
      case "--mode":
        opts.mode = value(arg, i++).toLowerCase();
        if (!MODES.includes(opts.mode)) {
          throw new UsageError(`Unknown mode "${opts.mode}". Known: ${MODES.join(", ")}.`);
        }
        break;
      case "--csv":
        opts.csv = true;
        break;
      case "--no-csv":
        opts.csv = false;
        break;
      case "--app-dir":
        opts.app.dir = value(arg, i++);
        break;
      case "--task-service":
        opts.taskService = value(arg, i++);
        break;
      case "-y":
      case "--yes":
        opts.yes = true;
        break;
      default:
        throw new UsageError(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

// Shared by --ids and the prompt, so both accept the same shapes and reject the same
// way. Commas, whitespace or both; deduped with the order preserved, which keeps the
// matrix checkable against the list you supplied.
function parseIds(raw) {
  const tokens = String(raw)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const invalid = tokens.filter((t) => !/^\d+$/.test(t));
  if (invalid.length) {
    throw new UsageError(
      `Not integer accounting_documents.id values: ${invalid.join(", ")}`
    );
  }
  if (!tokens.length) throw new UsageError("No credit note ids given.");
  return [...new Set(tokens)];
}

// --- colour ------------------------------------------------------------------
//
// Same convention as the other scripts here: cyan for SQL, bright white for
// section headers, faint for progress chatter. Off when stdout isn't a terminal
// or when NO_COLOR is set (https://no-color.org), so piping stays clean.

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

const SQL_ECHO_LIMIT = 500;

// Echo a statement before it runs, indented and cyan. This script reads
// production, so what it asks for should never be a mystery.
function echoSql(label, sql, why) {
  const shown =
    sql.length > SQL_ECHO_LIMIT
      ? `${sql.slice(0, SQL_ECHO_LIMIT)}\n… (${sql.length - SQL_ECHO_LIMIT} more chars)`
      : sql;

  output.write(`  ${c.faint(label)}\n`);
  // The reasoning travels with the statement. A query you can read but not justify is
  // the thing that gets copied into the next script unchanged.
  if (why) for (const line of why.split("\n")) output.write(`    ${c.faint(`· ${line}`)}\n`);
  for (const line of shown.split("\n")) output.write(`    ${c.sql(line)}\n`);
}

// --- prompting ---------------------------------------------------------------
//
// One readline for the whole run, with a line queue. The per-question
// createInterface pattern silently loses answers when stdin is a pipe: the
// second interface swallows lines the first had already buffered.

let rl = null;
let inputClosed = false;
const bufferedLines = []; // lines that arrived before anyone asked for them
const waitingAskers = []; // resolvers parked until the next line shows up

function ensureRl() {
  if (rl) return rl;

  inputClosed = false;
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
// Ctrl-D, or a piped script one line short, must not answer a prompt for you.
function endOfInput() {
  throw new UsageError("Input ended before the prompt was answered. Aborting; nothing was read.");
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

// Like ask(), but a closed stdin yields the fallback instead of aborting. Reserved for
// questions with no safety consequence: "also write a CSV?" is not an approval, and a
// piped invocation written before this prompt existed should skip the extra file rather
// than fail after the work is already done. Anything that gates a read or a write must
// use ask().
async function askOptional(question, fallback) {
  ensureRl();
  output.write(question);

  const skipped = () => {
    output.write(`${c.faint("(no input — skipped)")}\n`);
    return fallback;
  };

  if (bufferedLines.length) return bufferedLines.shift();
  // Either stdin had already ended, or it ends while we are parked on it. Both mean
  // the same thing, so both say so — silence here reads as a hung prompt.
  if (inputClosed) return skipped();

  const line = await new Promise((resolve) => waitingAskers.push(resolve));
  return line === null ? skipped() : line;
}

// Numbered menu. Accepts the number, any of the option's aliases, or blank for
// the default. Re-asks up to 3 times on nonsense.
async function askChoice(title, choices) {
  const def = choices.find((ch) => ch.default) || choices[0];

  output.write(`\n${c.head(title)}\n`);
  choices.forEach((ch, i) => {
    const marker = ch === def ? c.faint(" (default)") : "";
    output.write(`  ${i + 1}) ${ch.label}${marker}\n`);
    if (ch.detail) output.write(`     ${c.faint(ch.detail)}\n`);
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = (await ask("  > ")).trim().toLowerCase();
    if (!raw) return def.value;

    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].value;

    const match = choices.find((ch) => (ch.aliases || []).includes(raw));
    if (match) return match.value;

    output.write(
      `  ${c.bad(`Not an option. Enter 1-${choices.length}, a name, or blank for the default.`)}\n`
    );
  }
  throw new UsageError("Too many invalid answers.");
}

// --- psql --------------------------------------------------------------------

function isProd(namespace) {
  return PROD_NAMESPACES.has(namespace.toLowerCase());
}

// The psql database environment for a given deploy namespace.
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

// Every statement this run executed, in order, so the outputs can carry the exact
// SQL rather than a prose description of it. cross-check.sql is a curated copy and
// can drift; this cannot.
const EXECUTED = [];

// Read-only psql. -t -A -F| gives bare pipe-delimited rows; a NULL column comes
// back as an empty field, which is why every nullable column below is wrapped in
// coalesce() — an empty field is then unambiguous rather than "NULL or ''".
function psqlRead(env, db, sql, why = "") {
  echoSql(`houston psql ${env} ${db}`, sql, why);
  EXECUTED.push({ db, sql, why });

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

// Split psql output into per-row field arrays. `houston psql` prefixes its output
// with a correlation-id / timestamp preamble, so drop any line that doesn't have
// the expected field count.
function parseRows(out, fieldCount) {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => line.split("|"))
    .filter((fields) => fields.length === fieldCount);
}

function chunked(items, size = CHUNK) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// --- value guards ------------------------------------------------------------
//
// Everything interpolated into a statement passes through one of these first.
// Nothing here comes from a place that could smuggle SQL — the ids are typed by
// a human and the rest is read back out of the database — but a read against
// production is not the place to rely on that.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

function guardDate(value, what) {
  const s = String(value).trim();
  if (!DATE_RE.test(s)) throw new Error(`Expected a YYYY-MM-DD date for ${what}, got: ${value}`);
  return s;
}

// --- queries -----------------------------------------------------------------
//
// Each query carries a WHY, printed above it as it runs and written into every output
// (the report's "SQL executed" section, and the .sql beside the decode CSV). Single
// source: the reasoning cannot drift from the statement it explains, because they are
// passed together.

const WHY = {
  suppliedDocs: [
    "STEP 1 of 4 — is the input the right kind of thing, and what is its cross-database key?",
    "",
    "You supply accounting_documents.id values. Two things must come out: proof each is a",
    "B2B credit note, and einvoice_reference — the ONLY key that reaches shedul.",
    "",
    "Both conditions are needed. document_type = 'credit_note' alone lets a B2C sale refund",
    "through, and that has a sale_id and no partner-billing counterpart for shedul to",
    "resolve. einvoice_reference IS NOT NULL is what separates the two.",
  ].join("\n"),

  shedulCreditNotes: [
    "STEP 2 of 4 — the provider, the billing period, and the credit note's TRUE value.",
    "",
    "THE PROVIDER MUST COME FROM HERE. accounting_documents.provider_id is NULL on B2B",
    "billing documents; take it from step 1 and the candidate pool is empty. Not a",
    "preference — the only source.",
    "",
    "THE VALUE IS sum(provider_invoice_items.fee), NOT provider_invoices.total. `total` is",
    "wrong on 280 of 295 production credit notes: it carries the CO-CREATED INVOICE's total.",
    "Comparing against it would compare an invoice's total with a copy of itself, so every",
    "match would pass by construction and prove nothing.",
    "  e.g. CN/1006 — stored total 1224042, items sum -81606. 12240.42 is INV/16204's total.",
  ].join("\n"),

  providerInvoices: [
    "STEP 3 of 4 — the candidate pool. Three decisions, three ways to be wrong.",
    "",
    "NO BILLING-PERIOD FILTER. The obvious query restricts to the credit note's own month and",
    "is wrong: 37 of 295 credit notes are worth more than every invoice in their own period,",
    "because handle_invoice_and_credit_note splits a month's items by SIGN, not by amount, and",
    "a `credit` item is an adjustment rather than a reversal of that month's fees. CN/1044 is",
    "2000.00 against an own-month invoice of 1165.13. Filter by period and those 37 go",
    "unmatched.",
    "",
    "einvoice_reference IS NOT NULL. Without it the pool gains the 1.8M pre-rollout invoices",
    "and the 1.25M not_applicable non-KSA ones. Those are NOT failed emissions — the check for",
    "'an e-invoicing provider's invoice, after the cutoff, missing a reference' returns 0 — but",
    "pointing a ZATCA credit note at a document ZATCA has never seen is not a useful answer.",
    "Costs 2 matches of 295.",
    "",
    "NO einvoice_status FILTER, and this is the one people reach for. An earlier version",
    "dropped `rejected`/`refunded` candidates and was wrong: invoices and their credit notes",
    "are created in the SAME transaction, 23-24 ms apart, and for 43 of 63 then-ambiguous",
    "credit notes the co-created invoice was the `refunded` one — the very row it discarded.",
  ].join("\n"),

  invoiceTrackers: [
    "STEP 4 of 4 — the matched invoice's own reference and ZATCA status.",
    "",
    "receipt_number is read HERE rather than taken from shedul's invoice_reference because it",
    "is the value a credit note's previous_receipt_number must carry, and that field is",
    "consumed by the e-invoicing side. Both agree on all 34 — but that is a fact about today's",
    "data, not a guarantee, and a divergence would yield a valid-looking document citing an",
    "invoice number the tax authority cannot resolve. A mismatch is reported, not assumed away.",
  ].join("\n"),
};

// The match itself runs in Node, so it has no query to hang its reasoning on. It is
// printed under the matrix and written into the report instead.
const WHY_MATCH = [
  "THE MATCH — pickInvoice(). Three hard constraints, then a ranking:",
  "",
  "  ELIGIBLE  1. einvoice_reference IS NOT NULL   (applied in the candidate query)",
  "            2. billing_end <= credit note's billing_end",
  "            3. total >= credit note value",
  "  RANK      closest first, going backwards: latest billing period, then latest",
  "            created_at within it, then highest id",
  "",
  "(2) IS THE BILLING PERIOD, NOT created_at, and they are not interchangeable: a February",
  "invoice is written on 2026-03-02, after February ends, and its credit note 35 ms later in",
  "the same transaction. So `created_at < billingStart` is false for EVERY own-period invoice",
  "and would discard the common case entirely. The period is the key; timestamps break ties.",
  "",
  "A LATER invoice is INELIGIBLE, not a last resort — a document that did not exist cannot be",
  "the one credited. So a credit note whose only large-enough invoice is later comes back",
  "UNMATCHED rather than citing it.",
  "",
  "No 'own period first' key is needed: with (2) in force the own period has the greatest",
  "billing_end of any eligible invoice, so it sorts first by construction.",
  "",
  "(3) compares invoice.total AS STORED against the credit note's magnitude, so the 194",
  "production invoices with a negative total never qualify — intended. Both sides are GROSS:",
  "total = subtotal + tax, and the credit note sums `fee`, which is gross with `fee_tax`",
  "inside it.",
  "",
  "No AMBIGUOUS verdict exists — the ranking is a total order, so it resolves to one invoice",
  "or to none. UNMATCHED prints the largest ELIGIBLE invoice beside it, and both the eligible",
  "and total invoice counts, since 'none eligible' and 'none big enough' want different fixes.",
  "",
  "HOW FAR THE CHECKS GO:",
  "  SQL row_number()  34/34  transcription and ordering bugs in either implementation.",
  "                           NOT the rule — both encode the same one. (cross-check.sql §2)",
  "  co-creation       29/34  whether the rule agrees with the code that created the rows.",
  "                           Unavailable for the 5 that differ — exactly where the answer is",
  "                           least obvious. (cross-check.sql §3)",
  "  ZATCA's verdict          everything. The only check that settles it.",
  "",
  "THE HONEST WEAK POINT: the amount rule and the ranking are inferences chosen against",
  "production data, not consequences of a schema relationship. Nothing here can prove them.",
  "",
  "THINNEST RESULT IN THE 34: CN/1098, worth 278.00 — its provider has no invoice at all in",
  "the credit note's month and the nearest is 277.18, short by 0.82, so the match lands three",
  "months back on INV/18891. The rule working as specified, and the row to check by hand.",
].join("\n");

// Step 1 — the supplied ids, as accounting_documents sees them, plus the latest
// tracker. This is what decides whether the input really is a B2B credit note:
// document_type says credit note, and einvoice_reference (not sale_id) says the
// document came from partner billing rather than from a sale refund.
//
// Both conditions are needed. document_type alone lets a B2C sale refund through, and
// that has no partner-billing counterpart for shedul to resolve. einvoice_reference is
// also the only key that reaches the other database.
function fetchSuppliedDocs(env, ids) {
  const docs = new Map();

  for (const batch of chunked(ids)) {
    const idList = batch.map((id) => guardInt(id, "accounting_documents.id")).join(",");
    const sql =
      "SELECT ad.id::text, ad.document_type::text, coalesce(ad.receipt_number, ''),\n" +
      "       coalesce(ad.einvoice_reference, ''), coalesce(ad.sale_id_64::text, ''),\n" +
      "       coalesce(ad.deleted_at::text, ''),\n" +
      "       coalesce(t.review_status::text, ''), coalesce(t.upload_status::text, '')\n" +
      "FROM accounting_documents ad\n" +
      "LEFT JOIN e_invoice_trackers t ON t.id = ad.latest_tracker_id\n" +
      `WHERE ad.id IN (${idList})\n` +
      "ORDER BY ad.id;";

    for (const f of parseRows(psqlRead(env, AD_DB, sql, WHY.suppliedDocs), 8)) {
      docs.set(f[0], {
        id: f[0],
        documentType: f[1],
        receiptNumber: f[2],
        einvoiceReference: f[3],
        saleId: f[4],
        deletedAt: f[5],
        reviewStatus: f[6],
        uploadStatus: f[7],
      });
    }
  }
  return docs;
}

// Step 2 — the shedul side of each credit note. einvoice_reference is the join
// key: a uuid, unique on both sides. This is also where provider_id comes from;
// accounting_documents.provider_id is NULL for B2B billing documents.
function fetchShedulCreditNotes(env, refs) {
  const byRef = new Map();

  for (const batch of chunked(refs)) {
    const list = batch
      .map((r) => `'${guardUuid(r, "provider_invoices.einvoice_reference")}'`)
      .join(", ");
    // item_value is the sum of the credit note's own line items and is the figure the
    // match uses. `total` is NOT usable here: on 280 of 295 production credit notes it
    // does not equal the sum of its items — it carries the invoice's total instead
    // (verified: invoices are self-consistent 12893/12893, credit notes 15/295). Using
    // it would compare an invoice's total against a copy of itself, so every match
    // would pass by construction and prove nothing.
    //
    // Worked example, CN/1006: stored total 1224042, items sum -81606. 12240.42 is
    // exactly INV/16204's total.
    const sql =
      "SELECT c.einvoice_reference::text, c.id::text, c.provider_id::text,\n" +
      "       coalesce(c.invoice_reference, ''), c.billing_start::text, c.billing_end::text,\n" +
      "       c.invoice_date::text, coalesce(c.einvoice_status::text, ''), c.total::text,\n" +
      "       coalesce(i.item_value::text, ''), c.created_at::text\n" +
      "FROM provider_invoices c\n" +
      "LEFT JOIN (\n" +
      "  SELECT provider_invoice_id, sum(fee) AS item_value\n" +
      "  FROM provider_invoice_items GROUP BY provider_invoice_id\n" +
      ") i ON i.provider_invoice_id = c.id\n" +
      `WHERE c.einvoice_reference IN (${list})\n` +
      "  AND c.billing_document_type = 'credit_note'\n" +
      "ORDER BY c.provider_id, c.id;";

    for (const f of parseRows(psqlRead(env, SHEDUL_DB, sql, WHY.shedulCreditNotes), 11)) {
      const itemValue = f[9] === "" ? null : Number(f[9]);
      byRef.set(f[0], {
        einvoiceReference: f[0],
        id: f[1],
        providerId: f[2],
        invoiceReference: f[3],
        billingStart: f[4],
        billingEnd: f[5],
        invoiceDate: f[6],
        einvoiceStatus: f[7],
        storedTotal: Number(f[8]),
        // Signs are inconsistent in both fields, so everything downstream compares
        // magnitudes. A credit note with no line items at all falls back to the stored
        // total — there is nothing better — and is flagged in the output.
        itemValue,
        value: Math.abs(itemValue === null ? Number(f[8]) : itemValue),
        valueFromStoredTotal: itemValue === null,
        createdAt: f[10],
      });
    }
  }
  return byRef;
}

// Step 3 — every E-INVOICED invoice belonging to these providers, in ANY billing period.
//
// The value constraint is absolute and the period is not, so the period cannot be used
// to narrow the query: an invoice from a different month is a legitimate match, and for
// 37 of 295 production credit notes it is the only possible one, because the credit
// exceeds every invoice in its own period.
//
// `einvoice_reference IS NOT NULL` is the deliberate scope: a credit note may only be
// matched to an invoice that actually exists as an e-invoice document. Without it the
// pool includes the 1.8M invoices that predate the KSA rollout (`invoice_date <=
// 2025-06-30`) and the 1.25M `not_applicable` non-KSA ones. Those are not failed
// emissions — nothing was dropped, e-invoicing simply did not apply — but matching a
// ZATCA credit note to a document ZATCA has never seen is not a useful answer.
//
// einvoice_status is deliberately NOT filtered on, and it is the thing people reach for.
// An earlier version dropped `rejected`/`refunded` candidates and was wrong: invoices and
// their credit notes are created in the SAME transaction, 23-24 ms apart, and for 43 of
// 63 then-ambiguous credit notes the co-created invoice was the `refunded` one — exactly
// the row the status rule discarded. See "Why not statuses" in AGENTS.md.
//
// A provider has one invoice per month, so this is tens of rows each, not thousands.
// `total` is used as stored — unlike credit notes, invoice totals agree with their
// line items on all 12 893 e-invoiced rows.
function fetchProviderInvoices(env, providerIds) {
  const byProvider = new Map();

  for (const batch of chunked(providerIds)) {
    const list = batch.map((id) => guardInt(id, "provider_invoices.provider_id")).join(",");
    const sql =
      "SELECT i.provider_id::text, i.billing_start::text, i.billing_end::text,\n" +
      "       i.id::text, coalesce(i.invoice_reference, ''), i.invoice_date::text,\n" +
      "       coalesce(i.einvoice_status::text, ''), i.einvoice_reference::text,\n" +
      "       i.total::text, i.created_at::text\n" +
      "FROM provider_invoices i\n" +
      `WHERE i.provider_id IN (${list})\n` +
      "  AND i.billing_document_type = 'invoice'\n" +
      "  AND i.einvoice_reference IS NOT NULL\n" +
      "ORDER BY i.provider_id, i.created_at, i.id;";

    for (const f of parseRows(psqlRead(env, SHEDUL_DB, sql, WHY.providerInvoices), 10)) {
      const invoice = {
        providerId: f[0],
        billingStart: f[1],
        billingEnd: f[2],
        id: f[3],
        invoiceReference: f[4],
        invoiceDate: f[5],
        einvoiceStatus: f[6],
        einvoiceReference: f[7],
        total: Number(f[8]),
        createdAt: f[9],
      };
      if (!byProvider.has(invoice.providerId)) byProvider.set(invoice.providerId, []);
      byProvider.get(invoice.providerId).push(invoice);
    }
  }
  return byProvider;
}

// Step 4 — the matched invoices as accounting_documents sees them, so the matrix
// can show how far each invoice actually got with the tax authority.
//
// receipt_number is read here rather than taken from shedul's invoice_reference because
// it is the value a credit note's `previous_receipt_number` must carry (the `decode` mode
// patches it in), and that field is consumed by the e-invoicing side, whose own idea of
// the reference is this column. The two agree on every row checked — but "they agree" is
// a fact about today's data, not a guarantee, and the cost of reading the authoritative
// one is nil.
function fetchInvoiceTrackers(env, refs) {
  const byRef = new Map();

  for (const batch of chunked(refs)) {
    const list = batch
      .map((r) => `'${guardUuid(r, "accounting_documents.einvoice_reference")}'`)
      .join(", ");
    const sql =
      "SELECT ad.einvoice_reference, ad.id::text, coalesce(ad.receipt_number, ''),\n" +
      "       coalesce(t.review_status::text, ''), coalesce(t.upload_status::text, '')\n" +
      "FROM accounting_documents ad\n" +
      "LEFT JOIN e_invoice_trackers t ON t.id = ad.latest_tracker_id\n" +
      "WHERE ad.document_type = 'invoice'\n" +
      `  AND ad.einvoice_reference IN (${list})\n` +
      "ORDER BY ad.id;";

    for (const f of parseRows(psqlRead(env, AD_DB, sql, WHY.invoiceTrackers), 5)) {
      byRef.set(f[0], {
        docId: f[1],
        receiptNumber: f[2],
        reviewStatus: f[3],
        uploadStatus: f[4],
      });
    }
  }
  return byRef;
}

// --- matching ----------------------------------------------------------------

// Verdicts, worst-first for the summary line. There is deliberately no AMBIGUOUS:
// the amount rule below is a total order, so it always resolves to one invoice or
// to none.
const VERDICT = {
  MATCHED: "matched",
  UNMATCHED: "UNMATCHED",
  ORPHAN: "ORPHAN",
};

function samePeriod(a, b) {
  return a.billingStart === b.billingStart && a.billingEnd === b.billingEnd;
}

// The invoice that carries the credit note.
//
// THREE HARD CONSTRAINTS. An invoice is eligible only if all three hold:
//
//   1. it has a reference          einvoice_reference IS NOT NULL, applied in the
//                                  candidate query — a document ZATCA has never seen is
//                                  not one a ZATCA credit note can cite
//   2. its period is at or before  billing_end <= creditNote.billingEnd
//   3. it is large enough          total >= creditNote.value
//
// (2) is the billing PERIOD, not created_at. Those are not interchangeable: a February
// invoice is written on 2026-03-02, after February has ended, and its credit note 35 ms
// later in the same transaction. So `created_at < billingStart` is false for EVERY
// own-period invoice and would discard the common case entirely. The period is the right
// key; the timestamps only break ties.
//
// An invoice from a LATER period is not a last resort here — it is ineligible. A document
// that did not exist cannot be the one credited. The consequence is that a credit note
// whose only large-enough invoice is later comes back UNMATCHED rather than citing it.
//
// (3) compares `i.total` AS STORED against the credit note's magnitude, so the 194
// production invoices with a negative total never qualify. Intended. Both sides are gross
// (tax-inclusive): `total` = subtotal + tax, and the credit note's value sums `fee`, which
// is itself gross with `fee_tax` inside it.
//
// RANKING among the eligible — closest first, going backwards:
//   1. latest billing period      (the credit note's own, when it qualifies)
//   2. latest created_at within that period
//   3. highest id
//
// No separate "own period first" key is needed: with (2) in force, the own period has the
// greatest billing_end of any eligible invoice, so it sorts first by construction.
function pickInvoice(creditNote, candidates) {
  // Constraint 2, then 3. Kept as one pass with the reason each row survived or died
  // available to the caller below.
  const inWindow = candidates.filter((i) => i.billingEnd <= creditNote.billingEnd);
  const qualifying = inWindow.filter((i) => i.total >= creditNote.value);

  const sorted = qualifying.slice().sort((a, b) => {
    if (a.billingEnd !== b.billingEnd) return b.billingEnd.localeCompare(a.billingEnd);
    if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
    return Number(b.id) - Number(a.id);
  });

  // For an unmatched credit note the useful fact is the best that was ELIGIBLE, not the
  // provider's biggest invoice overall — a later invoice being large enough is not a near
  // miss, it is out of scope.
  const largest = inWindow.reduce(
    (best, i) => (best === null || i.total > best.total ? i : best),
    null
  );

  // The credit note's OWN-period invoice, reported whether or not it won. When the match
  // reached further back this is what explains why — and the largest of them is the
  // relevant one, since if any own-period invoice had been big enough the ranking above
  // would have chosen it.
  const ownPeriod = candidates.filter((i) => samePeriod(i, creditNote));
  const ownPeriodBest = ownPeriod.reduce(
    (best, i) => (best === null || i.total > best.total ? i : best),
    null
  );

  return {
    invoice: sorted.length ? sorted[0] : null,
    candidateCount: candidates.length,
    eligibleCount: inWindow.length,
    largest: sorted.length ? null : largest,
    ownPeriodBest,
    ownPeriodCount: ownPeriod.length,
  };
}

// One result per supplied credit note.
function matchCreditNotes(docs, cnByRef, invByProvider) {
  return docs.map((doc) => {
    const cn = cnByRef.get(doc.einvoiceReference);

    // In accounting_documents but not in shedul. Worth surfacing rather than
    // reporting as "no invoice found": the credit note itself is missing.
    if (!cn) {
      return {
        doc,
        cn: null,
        invoice: null,
        largest: null,
        candidateCount: 0,
        eligibleCount: 0,
        ownPeriodBest: null,
        ownPeriodCount: 0,
        verdict: VERDICT.ORPHAN,
      };
    }

    const candidates = invByProvider.get(cn.providerId) || [];
    const picked = pickInvoice(cn, candidates);

    return {
      doc,
      cn,
      ...picked,
      verdict: picked.invoice ? VERDICT.MATCHED : VERDICT.UNMATCHED,
    };
  });
}

// --- output ------------------------------------------------------------------

const DASH = "—";

// Fixed-width table with a drawn grid. The matrix runs to eight columns and can be
// dozens of rows, and at that size space-padded columns are hard to track across —
// the rules give the eye something to follow. Plain box-drawing only, so it still
// copy-pastes into a ticket or a Slack code block unchanged.
//
// `align` is per column: "r" right-aligns, anything else left-aligns. Amounts are
// right-aligned so the decimal points stack and an outlier is visible at a glance.
function renderTable(headers, rows, align = []) {
  // Measure what the eye sees, not what the string holds: a coloured cell carries
  // escape bytes that padEnd would otherwise count as width.
  const visible = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
  const width = (s) => visible(s).length;
  const pad = (s, w, right) => {
    const gap = " ".repeat(Math.max(0, w - width(s)));
    return right ? gap + String(s) : String(s) + gap;
  };

  const widths = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]))));
  const rule = (l, m, r) => l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const line = (cells) =>
    `│ ${cells.map((cell, i) => pad(cell, widths[i], align[i] === "r")).join(" │ ")} │`;

  return [
    rule("┌", "┬", "┐"),
    line(headers),
    rule("├", "┼", "┤"),
    ...rows.map(line),
    rule("└", "┴", "┘"),
  ].join("\n");
}

// shedul's billing status, then how far the document got with the tax authority.
// Two different questions — "did we bill it" and "did ZATCA take it" — so they
// stay side by side rather than collapsing into one word.
function statusCell(shedulStatus, reviewStatus, uploadStatus) {
  // Nothing known at all — an invoice that was never e-invoiced has neither. Collapse to
  // a single dash rather than "— (—)", which is noise on screen and, being a composite
  // string, would survive into the CSV instead of becoming an empty cell.
  if (!shedulStatus && !reviewStatus && !uploadStatus) return DASH;

  const billing = shedulStatus || DASH;
  const zatca = reviewStatus || uploadStatus ? `${reviewStatus || DASH}/${uploadStatus || DASH}` : DASH;
  return `${billing} (${zatca})`;
}

function verdictCell(verdict) {
  return verdict === VERDICT.MATCHED ? c.ok(verdict) : c.bad(verdict);
}

// Spelled out rather than taken from toLocaleString: the month name should not depend
// on the machine's locale or on whether the Node build shipped full ICU.
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// "April 2026" from a YYYY-MM-DD string. Sliced, not parsed through Date — a bare
// date string is treated as UTC midnight and would slip to the previous month for
// anyone west of Greenwich.
function monthName(isoDate) {
  if (!isoDate || !DATE_RE.test(isoDate)) return null;
  const [year, month] = isoDate.split("-");
  return `${MONTH_NAMES[Number(month) - 1]} ${year}`;
}

// Every billing period seen on production is a whole calendar month, but derive it
// from both ends rather than assume: one that straddles a boundary gets both names
// instead of a confidently wrong one.
function monthCell(billingStart, billingEnd) {
  const start = monthName(billingStart);
  const end = monthName(billingEnd);
  if (!start && !end) return DASH;
  if (!start || !end || start === end) return start || end;
  return `${start} – ${end}`;
}

// Totals are minor units in the database. Rendered with two decimals and no
// currency symbol: a period can mix issuer and issuee currencies, so a symbol here
// would be a guess.
function amountCell(minorUnits) {
  if (minorUnits === null || minorUnits === undefined || Number.isNaN(minorUnits)) return DASH;
  return (minorUnits / 100).toFixed(2);
}

// `invoice_date` used to have its own column. It is gone: it equals billing_end on
// every production row, so with both billing periods now shown in full it carried no
// information and cost width on an already wide table.

// The credit note's printed reference. Prefer shedul's, fall back to the mirror's
// receipt_number — they are the same string, but an ORPHAN has no shedul row at all.
function creditNoteRef(result) {
  return (result.cn && result.cn.invoiceReference) || result.doc.receiptNumber || DASH;
}

// invoice_reference is only populated once a document has been issued, so a
// candidate can legitimately have none.
function invoiceRef(invoice) {
  return (invoice && invoice.invoiceReference) || DASH;
}

// Reference and row id go in separate columns. Crammed into one cell they cannot
// align — "CN/994" and "CN/1044" are different widths, so the id after them wanders
// and the eye has nothing to track down the page.
function idCell(value) {
  return value === null || value === undefined || value === "" ? DASH : String(value);
}

// Why the match is not the credit note's own-period invoice. A cross-period match is a
// valid result, but it always has a reason and the reason is always an amount or an
// absence — so state it rather than leaving the reader to work it out from four dates and
// two totals.
function whyNotOwnPeriod(result, invoice) {
  const cn = result.cn;
  if (!cn) return DASH;

  if (invoice && samePeriod(invoice, cn)) return "own period";

  const own = result.ownPeriodBest;
  if (!own) return `no invoice in ${monthCell(cn.billingStart, cn.billingEnd)}`;

  // The ranking prefers the own period, so if we are here the own-period invoice cannot
  // have been large enough — there is no other way to lose.
  return `own period too small: ${amountCell(own.total)} < ${amountCell(cn.value)}`;
}

// Exactly one row per supplied credit note — the amount rule always yields a
// single invoice or none, so there are no continuation rows.
function matrixRows(results, invTrackers) {
  return results.map((r) => {
    const invoice = r.invoice;
    const tracker = (invoice && invTrackers.get(invoice.einvoiceReference)) || {};

    return {
      result: r,
      invoice,
      cnRef: creditNoteRef(r),
      adId: idCell(r.doc.id),
      // An ORPHAN has no shedul row, so no provider_invoices id, no provider, no period.
      cnPiId: r.cn ? idCell(r.cn.id) : DASH,
      providerId: r.cn ? idCell(r.cn.providerId) : DASH,
      cnMonth: r.cn ? monthCell(r.cn.billingStart, r.cn.billingEnd) : DASH,
      cnStart: r.cn ? r.cn.billingStart : DASH,
      cnEnd: r.cn ? r.cn.billingEnd : DASH,
      cnTotal: r.cn ? amountCell(r.cn.value) : DASH,
      invRef: invoiceRef(invoice),
      piId: invoice ? idCell(invoice.id) : DASH,
      invMonth: invoice ? monthCell(invoice.billingStart, invoice.billingEnd) : DASH,
      invStart: invoice ? invoice.billingStart : DASH,
      invEnd: invoice ? invoice.billingEnd : DASH,
      invTotal: invoice ? amountCell(invoice.total) : DASH,
      // Whether the match had to reach outside the credit note's own month. The whole
      // reason both periods are shown, so it gets its own word rather than leaving the
      // reader to diff two dates.
      periodMatch: !r.cn || !invoice ? DASH : samePeriod(invoice, r.cn) ? "same" : "DIFFERENT",
      // The own-period invoice, reported whether or not it won — and when it didn't, why.
      ownRef: invoiceRef(r.ownPeriodBest),
      ownPiId: r.ownPeriodBest ? idCell(r.ownPeriodBest.id) : DASH,
      ownTotal: r.ownPeriodBest ? amountCell(r.ownPeriodBest.total) : DASH,
      whyNotOwn: whyNotOwnPeriod(r, invoice),
      cnStatus: statusCell(
        r.cn ? r.cn.einvoiceStatus : "",
        r.doc.reviewStatus,
        r.doc.uploadStatus
      ),
      invStatus: invoice
        ? statusCell(invoice.einvoiceStatus, tracker.reviewStatus, tracker.uploadStatus)
        : DASH,
      verdict: r.verdict,
    };
  });
}

// The matrix columns, defined once. The terminal table, the Markdown report and the
// CSV all render these same cells — three copies of this list would drift.
// Both sides' provider_invoices ids are named for their side. A bare
// `provider_invoice_id` meant the INVOICE's, which was fine only while the credit note's
// was absent — with both present the bare name would be a coin toss.
const MATRIX_HEADERS = [
  "Credit note",
  "accounting_document_id",
  "cn_provider_invoice_id",
  "provider_id",
  "CN month",
  "cn_billing_start",
  "cn_billing_end",
  "CN total",
  "Invoice",
  "inv_provider_invoice_id",
  "INV month",
  "inv_billing_start",
  "inv_billing_end",
  "INV total",
  "Period",
  "Own-period invoice",
  "own_period_invoice_id",
  "Own-period total",
  "Why not own period",
  "CN status",
  "Invoice status",
  "Match",
];

// Ids and money right-align; references, dates and prose read left to right.
const MATRIX_ALIGN = [
  "", "r", "r", "r", "", "", "", "r", "", "r", "", "", "", "r", "",
  "", "r", "r", "", "", "", "",
];

// Plain strings, no colour. Whoever wants a coloured verdict re-wraps the last cell.
function matrixCells(row) {
  return [
    row.cnRef,
    row.adId,
    row.cnPiId,
    row.providerId,
    row.cnMonth,
    row.cnStart,
    row.cnEnd,
    row.cnTotal,
    row.invRef,
    row.piId,
    row.invMonth,
    row.invStart,
    row.invEnd,
    row.invTotal,
    row.periodMatch,
    row.ownRef,
    row.ownPiId,
    row.ownTotal,
    row.whyNotOwn,
    row.cnStatus,
    row.invStatus,
    row.verdict,
  ];
}

function printMatrix(rows) {
  const body = rows.map((r) => {
    const cells = matrixCells(r);
    cells[cells.length - 1] = verdictCell(r.verdict);
    return cells;
  });

  output.write(`\n${c.head("── Credit note → invoice ───────────────────────────────")}\n`);
  output.write(`${renderTable(MATRIX_HEADERS, body, MATRIX_ALIGN)}\n`);
}

// The rule that produced the table above, printed under it. The four queries explain
// themselves as they run; the match happens in Node and has no statement to hang its
// reasoning on, so it says its piece here.
function printMatchLogic() {
  output.write(`\n${c.head("── How the match was made ──────────────────────────────")}\n`);
  for (const line of WHY_MATCH.split("\n")) output.write(`  ${c.faint(line)}\n`);
}

// Why an UNMATCHED credit note is unmatched. Two different reasons now that the period is
// a hard constraint, and they want different fixes, so both counts are shown:
//
//   Eligible = 0   the provider has no e-invoiced invoice at or before this period at all
//   Eligible > 0   there are some, but the largest is still too small
//
// `largest` is the biggest ELIGIBLE invoice, not the provider's biggest overall. A later
// invoice being large enough is not a near miss — it is out of scope — so quoting it here
// would read as "we nearly matched" when nothing of the sort happened.
//
// The guard is on eligibleCount, not candidateCount: with the period filter in force a
// provider can have dozens of invoices and none eligible, in which case `largest` is null.
function unmatchedRows(results) {
  return results
    .filter((r) => r.cn && !r.invoice)
    .map((r) => [
      creditNoteRef(r),
      idCell(r.doc.id),
      amountCell(r.cn.value),
      r.eligibleCount ? invoiceRef(r.largest) : DASH,
      r.eligibleCount ? idCell(r.largest.id) : DASH,
      r.eligibleCount ? amountCell(r.largest.total) : DASH,
      String(r.eligibleCount || 0),
      String(r.candidateCount || 0),
    ]);
}

const UNMATCHED_HEADERS = [
  "Credit note",
  "accounting_document_id",
  "Needs ≥",
  "Largest eligible",
  "provider_invoice_id",
  "Its total",
  "Eligible",
  "Invoices seen",
];

const UNMATCHED_ALIGN = ["", "r", "r", "", "r", "r", "r", "r"];

function printUnmatched(results) {
  const body = unmatchedRows(results);
  if (!body.length) return;

  output.write(`\n${c.head("── Unmatched: no invoice is large enough ───────────────")}\n`);
  output.write(`${renderTable(UNMATCHED_HEADERS, body, UNMATCHED_ALIGN)}\n`);
}

function countLabel(n) {
  return `${n} credit note${n === 1 ? "" : "s"}`;
}

function printSummary(results) {
  const tally = {};
  for (const r of results) tally[r.verdict] = (tally[r.verdict] || 0) + 1;

  const parts = [
    `${tally[VERDICT.MATCHED] || 0} matched`,
    `${tally[VERDICT.UNMATCHED] || 0} unmatched`,
    `${tally[VERDICT.ORPHAN] || 0} orphan`,
  ];
  output.write(`\n  ${parts.join(", ")}  (${countLabel(results.length)})\n`);
  return tally;
}

// --- rejected input ----------------------------------------------------------

// Why a supplied id is not something this script can match. Each reason is a
// different mistake and wants a different fix, so they never collapse into one
// "invalid id" bucket.
function rejectReason(id, doc) {
  if (!doc) return "NOT FOUND — no accounting_documents row with this id";
  if (doc.documentType !== "credit_note") {
    return `NOT A CREDIT NOTE — document_type is ${doc.documentType}`;
  }
  if (!doc.einvoiceReference) {
    return doc.saleId
      ? `NOT B2B — a sale refund credit note (sale_id ${doc.saleId}), not partner billing`
      : "NOT B2B — no einvoice_reference, so it has no partner-billing counterpart";
  }
  return null;
}

function printRejects(rejects) {
  output.write(`\n${c.head("── Not B2B credit notes — excluded ─────────────────────")}\n`);
  output.write(
    `${renderTable(
      ["accounting_documents.id", "Why"],
      rejects.map((r) => [r.id, c.bad(r.reason)])
    )}\n`
  );
}

// --- markdown report ---------------------------------------------------------
//
// Built from the result objects, never from the rendered terminal output: that
// carries ANSI escapes when stdout is a TTY, and its column padding is
// meaningless in Markdown. No c.* helper may appear in this section.

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
  return path.join(process.cwd(), `b2b-credit-notes-${namespace}-${day}.${extension}`);
}

// --- CSV export ---------------------------------------------------------------
//
// RFC 4180: a field holding a comma, a double quote or a newline is quoted, and any
// quote inside it is doubled. Built from the row objects like the Markdown is — never
// from the rendered table, which carries ANSI escapes and padding.

function csvCell(value) {
  // The em-dash is a display convention for "nothing". A spreadsheet wants an empty
  // cell instead, so it sorts and filters as absent rather than as text.
  const s = value === null || value === undefined || value === DASH ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(namespace, rows) {
  const file = outputPath(namespace, "csv");
  const lines = [MATRIX_HEADERS, ...rows.map(matrixCells)].map((cells) =>
    cells.map(csvCell).join(",")
  );

  // Trailing newline: POSIX text file, and it stops the last row being flagged as
  // truncated by anything strict.
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

// Same columns as the terminal table, plus the excluded input and the near misses —
// everything needed to check the work without re-running anything.
function writeReport(namespace, env, results, rows, rejects, tally) {
  const file = outputPath(namespace, "md");
  const body = rows.map(matrixCells);

  const lines = [
    `# B2B credit notes → invoices — ${namespace}`,
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- psql env: \`${env}\`, databases \`${AD_DB}\` + \`${SHEDUL_DB}\` (read-only)`,
    "- Candidates: invoices on the exact tuple " +
      "`(provider_id, billing_start, billing_end)`",
    "- Match: of those, the **last** (`created_at`, then `id`) whose `total` is " +
      "**≥ the credit note's total**. Statuses do not affect matching.",
    `- ${tally[VERDICT.MATCHED] || 0} matched, ${tally[VERDICT.UNMATCHED] || 0} unmatched, ` +
      `${tally[VERDICT.ORPHAN] || 0} orphan (${countLabel(results.length)})`,
    "",
    "## Matrix",
    "",
    mdTable(MATRIX_HEADERS, body),
  ];

  const unmatched = unmatchedRows(results);
  if (unmatched.length) {
    lines.push("", "## Unmatched: no invoice is large enough", "");
    lines.push(mdTable(UNMATCHED_HEADERS, unmatched));
  }

  if (rejects.length) {
    lines.push("", "## Excluded input (not B2B credit notes)", "");
    lines.push(mdTable(["accounting_documents.id", "Why"], rejects.map((r) => [r.id, r.reason])));
  }

  // The statements themselves, not a description of them. A report that says what the
  // rule is can be read charitably; one that shows the SQL can be checked.
  lines.push("", "## SQL executed", "");
  lines.push(`${EXECUTED.length} statement${EXECUTED.length === 1 ? "" : "s"}, in order.`, "");
  EXECUTED.forEach((q, i) => {
    lines.push(`### ${i + 1}. \`${q.db}\``, "", "```sql", q.sql, "```", "");
  });

  lines.push(
    "",
    "## Columns",
    "",
    "**CN total** is the sum of the credit note's own line items",
    "(`provider_invoice_items.fee`), NOT `provider_invoices.total`. On 280 of 295",
    "production credit notes that column does not equal its own items — it carries the",
    "invoice's total instead — so using it would compare an invoice against a copy of",
    "itself. Invoice totals are self-consistent on all 12 893 e-invoiced rows, so",
    "**INV total** is `provider_invoices.total` as stored.",
    "",
    "Both figures are magnitudes (stored signs are inconsistent), converted from minor",
    "units. No currency symbol: a billing period can mix issuer and issuee currencies.",
    "",
    "**Period** says whether the matched invoice is from the credit note's own billing",
    "period (`same`) or another one (`DIFFERENT`). The amount constraint is absolute and",
    "the period is not, so a cross-period match is a valid result, not an error.",
    "",
    "Each status is shedul's `einvoice_status`, then the ZATCA tracker as",
    "`review_status/upload_status`. A dash means there is no tracker.",
    ""
  );

  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

// --- interactive steps -------------------------------------------------------

async function askNamespace() {
  const raw = (await ask(`\nNamespace [${DEFAULT_NAMESPACE}]: `)).trim();
  return raw || DEFAULT_NAMESPACE;
}

// Accepts commas, whitespace, or one id per line. A blank line ends the list, so
// a paste straight out of a spreadsheet works.
async function askCreditNoteIds() {
  output.write(`\n${c.head("Credit note accounting_documents ids")}\n`);
  output.write(`  ${c.faint("comma or newline separated; a blank line ends the list")}\n`);

  for (let attempt = 0; attempt < 3; attempt++) {
    const collected = [];
    for (;;) {
      const line = await ask("  > ");
      if (!line.trim()) break;
      collected.push(line);
    }

    // Same parser as --ids, so both paths accept and reject identically. Its errors
    // are fatal on the command line but only a re-ask here.
    try {
      return parseIds(collected.join(","));
    } catch (err) {
      output.write(`  ${c.bad(err.message)}\n`);
      continue;
    }
  }
  throw new UsageError("No usable credit note ids given.");
}

// A mode that can mutate needs a human at the keyboard, in every namespace. Checked
// before anything is read, so a CI run that picked a write mode fails on the call
// rather than part-way through.
function requireInteractive(mode) {
  if (input.isTTY) return;
  if (!writesAnything(mode)) return;

  throw new UsageError(
    `Refusing to run "${mode}" without an interactive terminal.\n` +
      "  stdin is not a TTY, so approval could only come from a pipe or a script —\n" +
      '  and a piped "yes" is not explicit approval for a write.\n' +
      `  Run it from a terminal, or use a read-only mode: ${[...READ_ONLY_MODES].join(", ")}.\n` +
      "  Nothing was read and nothing was run."
  );
}

// The gate, before ANY database access. The matrix mode is read-only throughout, but
// it is still real production data, so the target is spelled out and approved first.
async function confirmDataAccess(opts, env, count) {
  const namespace = opts.namespace;
  const prod = isProd(namespace);

  output.write(`\n${c.head("── About to read real data ─────────────────────────────")}\n`);
  output.write(`  namespace : ${namespace}${prod ? "   ⚠  PRODUCTION" : ""}\n`);
  output.write(`  psql env  : ${env}\n`);
  output.write(`  mode      : ${opts.mode}   (read-only — cannot write)\n`);
  // decode never touches shedul; naming a database it does not read would be a lie in
  // exactly the place that has to be trustworthy.
  output.write(
    `  databases : ${opts.mode === "decode" ? AD_DB : `${AD_DB}, ${SHEDUL_DB}`}\n`
  );
  output.write(`  reading   : ${count} document id${count === 1 ? "" : "s"}\n`);
  if (opts.mode === "decode") {
    output.write(
      `  decode in : ${decodePayloads.resolveApp(opts.app).dir}   (local BEAM, mix run --no-start — no DB access)\n`
    );
  }
  output.write("  access    : SELECT only — this script has no write path\n");

  // --yes IS the approval for reads. The target is still printed above, so an
  // unattended run leaves the same record of what it touched; it just doesn't stop to
  // be told what it was already told on the command line. requireInteractive() has
  // already refused if the mode could write.
  if (opts.yes) {
    output.write(`  approved  : ${c.faint("--yes (non-interactive)")}\n`);
    return true;
  }

  // The prod/non-prod asymmetry lives in the DEFAULT: in production a bare Enter
  // cancels, so it takes a deliberate keystroke to read real production data.
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

// --- modes -------------------------------------------------------------------

// Steps 1-4, shared by both modes: validate the input, resolve it through shedul, match,
// and read the matched invoices back out of accounting_documents. Extracted so `decode`
// can reuse the matching rather than carry a second copy of it — a divergence here would
// put the wrong invoice reference into a tax document, which is the one kind of
// duplication worth avoiding in this directory.
//
// Returns null when there is nothing left to work with; the caller exits.
function computeMatrix(env, ids) {
  // 1. Is the input actually a set of B2B credit notes?
  const docs = fetchSuppliedDocs(env, ids);

  const rejects = [];
  const valid = [];
  for (const id of ids) {
    const doc = docs.get(id);
    const reason = rejectReason(id, doc);
    if (reason) rejects.push({ id, reason });
    else valid.push(doc);
  }

  if (rejects.length) printRejects(rejects);

  const deleted = valid.filter((d) => d.deletedAt);
  if (deleted.length) {
    output.write(
      `\n  ${c.warn(`Note: ${deleted.length} supplied credit note(s) are soft-deleted:`)} ` +
        `${deleted.map((d) => d.id).join(", ")}\n`
    );
  }

  if (!valid.length) {
    output.write(`\n  ${c.bad("Nothing left to match.")}\n`);
    return null;
  }

  // 2. The shedul side: provider and billing period.
  const cnByRef = fetchShedulCreditNotes(
    env,
    valid.map((d) => d.einvoiceReference)
  );

  // 3. Every invoice these providers have, in any period — the amount constraint is
  //    absolute, so the period cannot narrow the search. Deduped by provider.
  const providerIds = [...new Set([...cnByRef.values()].map((cn) => cn.providerId))];
  const invByProvider = providerIds.length ? fetchProviderInvoices(env, providerIds) : new Map();

  // 4. Match, then look up the ZATCA status of only the invoices that made it
  //    into the matrix.
  const results = matchCreditNotes(valid, cnByRef, invByProvider);

  const noItems = results.filter((r) => r.cn && r.cn.valueFromStoredTotal);
  if (noItems.length) {
    output.write(
      `\n  ${c.warn(`Note: ${noItems.length} credit note(s) have no line items; ` +
        "their value falls back to the stored total, which is unreliable:")} ` +
        `${noItems.map((r) => r.doc.id).join(", ")}\n`
    );
  }

  const invRefs = [
    ...new Set(
      results
        .map((r) => r.invoice && r.invoice.einvoiceReference)
        .filter((ref) => ref && UUID_RE.test(ref))
    ),
  ];
  const invTrackers = invRefs.length ? fetchInvoiceTrackers(env, invRefs) : new Map();

  return { rejects, results, invTrackers };
}

// The reference each credit note's `previous_receipt_number` must carry: the matched
// invoice's `accounting_documents.receipt_number`.
//
// Read from accounting_documents rather than from shedul's `invoice_reference`, because
// the field is consumed by the e-invoicing side and that is where the e-invoicing side's
// reference lives. The two agree on every production row seen so far — and a divergence
// would be exactly the kind of thing that produces a valid-looking document citing an
// invoice number the tax authority cannot resolve, so it is reported rather than assumed.
//
// A credit note with no match, or one matched to an invoice accounting_documents has no
// reference for, is absent from the result: there is nothing to write, and inventing a
// value is worse than leaving the row unpatched.
function matchedReferences(results, invTrackers) {
  const byDocId = new Map();
  const divergent = [];

  for (const r of results) {
    if (!r.invoice) continue;

    const tracker = invTrackers.get(r.invoice.einvoiceReference);
    if (!tracker || !tracker.receiptNumber) continue;

    if (r.invoice.invoiceReference && r.invoice.invoiceReference !== tracker.receiptNumber) {
      divergent.push(
        `${r.doc.id}: shedul ${r.invoice.invoiceReference} vs AD ${tracker.receiptNumber}`
      );
    }

    byDocId.set(r.doc.id, {
      previousReceiptNumber: tracker.receiptNumber,
      invoiceDocId: tracker.docId,
      providerInvoiceId: r.invoice.id,
      // Named separately from previousReceiptNumber even though they hold the same string:
      // one is "the invoice this credit note credits", the other is "the payload field being
      // written". They coincide today; conflating them in the output would hide it if they
      // ever stopped coinciding.
      invoiceReference: tracker.receiptNumber,
      // Both periods, in full. A cross-period match is legitimate here — the amount is the
      // only hard constraint — so the reader is given the two periods rather than a verdict.
      cnBillingStart: r.cn ? r.cn.billingStart : "",
      cnBillingEnd: r.cn ? r.cn.billingEnd : "",
      invBillingStart: r.invoice.billingStart,
      invBillingEnd: r.invoice.billingEnd,
    });
  }

  if (divergent.length) {
    output.write(
      `\n  ${c.warn(
        `Note: ${divergent.length} matched invoice(s) have different references in the two ` +
          "databases. accounting_documents wins:"
      )}\n${divergent.map((d) => `    ${d}\n`).join("")}`
    );
  }

  return byDocId;
}

// Mode `decode` — the matrix, then each credit note's payload with the matched invoice's
// reference patched into it. The matrix runs first because the patch is derived from it;
// it is printed rather than computed silently, so the reference written into each document
// is visible beside the evidence for it.
async function runDecode(opts, env, ids) {
  const matrix = computeMatrix(env, ids);
  if (!matrix) return EXIT_DATA;
  const { rejects, results, invTrackers } = matrix;

  printMatrix(matrixRows(results, invTrackers));
  printUnmatched(results);
  printMatchLogic();
  const tally = printSummary(results);

  const patches = matchedReferences(results, invTrackers);

  // Only what the matrix accepted. Passing the full `ids` list would decode the documents
  // step 1 just printed under "Not B2B credit notes — excluded", which is the script
  // contradicting itself: it would report an id as excluded and then dump its payload.
  // ORPHANs stay in — they passed validation and simply have no shedul row, so they are
  // credit notes worth decoding, just not patchable.
  //
  // To decode something that is not a B2B credit note, use ./decode_payloads.js directly.
  // That is what it is for.
  const validIds = results.map((r) => r.doc.id);

  // The matrix statements ran first, so they belong at the top of the .sql the decode side
  // writes — otherwise that file would show the payload read and none of the matching.
  const code = decodePayloads.runDecode(
    { ...opts, executedSql: EXECUTED.slice() },
    env,
    validIds,
    patches
  );

  // An unmatched or orphaned credit note is not a decode failure, but it is a credit note
  // that came out of here without a reference — so it still colours the exit code.
  const unresolved = (tally[VERDICT.UNMATCHED] || 0) + (tally[VERDICT.ORPHAN] || 0);
  return code || (unresolved || rejects.length ? EXIT_DATA : 0);
}

async function runMatrix(opts, env, ids) {
  const namespace = opts.namespace;

  const matrix = computeMatrix(env, ids);
  if (!matrix) return EXIT_DATA;
  const { rejects, results, invTrackers } = matrix;

  // 5. Report.
  const rows = matrixRows(results, invTrackers);
  printMatrix(rows);
  printUnmatched(results);
  printMatchLogic();
  const tally = printSummary(results);

  const file = writeReport(namespace, env, results, rows, rejects, tally);
  output.write(`  ${c.faint("report:")} ${file}\n`);

  // --csv / --no-csv decide it up front; otherwise it is offered after the table, so
  // the choice is made with the result in view.
  let wantCsv = opts.csv;
  if (wantCsv === null) {
    const answer = (await askOptional("\nAlso export the matrix as CSV? (y/N): ", ""))
      .trim()
      .toLowerCase();
    wantCsv = answer === "y" || answer === "yes";
  }
  if (wantCsv) {
    output.write(`  ${c.faint("csv:")} ${writeCsv(namespace, rows)}\n`);
  }

  const unresolved = (tally[VERDICT.UNMATCHED] || 0) + (tally[VERDICT.ORPHAN] || 0);
  return unresolved || rejects.length ? EXIT_DATA : 0;
}

// --- main --------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Each step asks only for what the command line didn't supply, so the interactive
  // and non-interactive paths converge here rather than forking.
  //
  // Without a terminal the two prompts that HAVE a sane default take it rather than
  // aborting — a prompt nobody can answer is not a safety feature. Both defaults are
  // safe by construction: MODES[0] is read-only, and requireInteractive() below
  // refuses any mode that could write when there is no TTY. The reads themselves are
  // still gated: no --yes, no queries.
  if (!opts.mode) {
    opts.mode = input.isTTY
      ? await askChoice("Mode:", [
          {
            label: "matrix — credit note → invoice",
            detail:
              "same provider, any billing period; the nearest invoice big enough to " +
              "carry the credit note",
            aliases: ["matrix", "m"],
            value: "matrix",
            default: true,
          },
          {
            label: "decode — what is inside payload_base64",
            detail:
              "decodes each document's stored Erlang term in the service's local BEAM and writes it to a " +
              "CSV, one record each",
            aliases: ["decode", "d", "payload", "payloads"],
            value: "decode",
          },
        ])
      : MODES[0];
  }

  requireInteractive(opts.mode);

  if (!opts.namespaceGiven && input.isTTY) opts.namespace = await askNamespace();
  const env = psqlEnv(opts.namespace);

  // The ids have no default — there is nothing sensible to guess — so say so plainly
  // rather than let the prompt die on a closed stdin with a generic message.
  if (!opts.ids && !input.isTTY) {
    throw new UsageError("--ids is required when there is no terminal to prompt on.");
  }
  const ids = opts.ids || (await askCreditNoteIds());

  if (!(await confirmDataAccess(opts, env, ids.length))) {
    output.write("\n  Cancelled. Nothing was read.\n");
    return EXIT_USAGE;
  }

  // Both modes take the same three things — namespace, ids, an approved gate — so the
  // dispatch is the only place they differ.
  return opts.mode === "decode" ? runDecode(opts, env, ids) : runMatrix(opts, env, ids);
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
