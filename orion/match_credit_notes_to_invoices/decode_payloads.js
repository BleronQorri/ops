#!/usr/bin/env node
//
// decode_payloads — what is actually inside an accounting document's payload_base64?
//
// `accounting_documents.payload_base64` is
//
//   Base.encode64(:erlang.term_to_binary(%AccountingDocuments.Structs.BillingDocument{}))
//
// written once at document creation (create_accounting_document_and_tracker_action.ex:235).
// Every value starts `g3` — 0x83, the Erlang External Term Format version byte. It is
// therefore unreadable by anything that isn't a BEAM, which is why inspecting one has
// until now meant the by-hand runbook in ../edit_document_payload/AGENTS.md §2-§3: pull
// the base64 with psql, open an IEx shell, paste it in, read the inspect output. Fine for
// one document; useless for thirty-four.
//
// This does the same three steps for a whole list of ids and writes the result to a CSV.
//
// Pipeline:
//   1. accounting_documents — the supplied ids' receipt_number and payload_base64.
//   2. The service's own BEAM — `mix run --no-start -e` in the local app-accounting-documents
//      checkout. Nothing but a BEAM can decode the terms, and the checkout has the app's
//      modules, so `Decimal` and the struct names render properly instead of as raw maps.
//   3. A CSV, one record per document.
//
// WHY LOCALLY, IN THE SERVICE'S CHECKOUT. Decoding is a pure function of the bytes, so it
// needs a BEAM with the app's modules and nothing else. The app-accounting-documents
// checkout next door has exactly that: `mix run --no-start` compiles if needed, loads every
// umbrella app's modules and starts none of them — no Repo, no database, no network. It
// replaces the earlier approach of borrowing a staging pod through `houston console … eval`,
// which needed cluster exec rights and a release path that moved with every redeploy.
//
// WHY `--no-start`. Starting the application would connect Repos and consumers; a decode
// has no use for any of it, and a script that reads production payloads should not also be
// pointing a local application at anything. Same reason the old pod path used `eval`
// rather than `remote`.
//
// WHY THE PAYLOADS GO IN ON STDIN. base64 contains `+`, `/` and `=`, and 34 payloads is
// ~140 KB — argv is the wrong channel on both counts. `IO.read(:stdio, :eof)` inside the
// evaluated program reads a piped payload correctly.
//
// WHY THE BEAM ANSWERS IN JSON. The answer itself is Elixir — an `inspect`ed term, which is
// what ends up in the CSV — but it needs an envelope to travel in, and every obvious
// delimiter appears inside the payload. Party names are free text from provider records:
// document 4836650's issuee is `Atira Beauty Lounge | اتيرا بيوتي لاونج`, with a literal
// pipe in it, so the pipe-delimited convention the psql reads here use would silently
// split that row. Addresses carry commas, and a pretty-printed term is full of newlines.
// JSON escapes exactly those, so the decoder emits one `ROW <json>` line per document and
// Node unwraps it; the prefix also discards everything else mix prints — compile progress,
// config warnings, Logger chatter.
//
// SAFETY
//   - Read-only. One SELECT, a pure-function decode, and a CSV in the working directory.
//     No `houston psql --write`, no Houston task, nothing written to any database.
//   - Every command is echoed before it runs.
//   - A confirmation gate before the first read; production defaults to Cancel.
//   - Ids are validated as integers before they reach a statement.
//
// Usage:
//   ./decode_payloads.js                          fully interactive
//   ./decode_payloads.js --ids 4836650 --yes      non-interactive
//
// Also reachable as `match_credit_notes_to_invoices.js --mode decode`, which hands its own ids and
// namespace straight to runDecode() below rather than re-implementing any of this.
//
// Prereqs: VPN up, `houston` authenticated (prod reads use fresha-production-developer); a
// local app-accounting-documents checkout with deps fetched. Node only, no dependencies.

"use strict";

const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// --- constants ---------------------------------------------------------------

const AD_DB = "accounting_documents";

const DEFAULT_NAMESPACE = "production";
const PROD_NAMESPACES = new Set(["production", "prod"]);

// An IN(...) list of a few thousand ids makes for an unwieldy statement and an
// unreadable echo. Split the reads instead; the results are merged in Node.
const CHUNK = 500;

// Documents per mix invocation. Each `mix run` boots a VM and loads the umbrella, several
// seconds a time, so batching is the whole point of this script — but an unbounded batch
// means an unbounded term list in memory and one enormous blob of output, so it is a batch
// rather than a single shot.
const BEAM_CHUNK = 200;

const ROW_PREFIX = "ROW ";

// --- the write, as a command you run yourself --------------------------------
//
// This script does not write. It emits the exact Houston task invocation that would, in a
// column, so the write stays a deliberate act by a human who can read the payload first.
//
// The chain, verified in app-accounting-documents:
//   houston task run <service> update_accounting_document_payload -p KEY=VALUE
//     -> run_task.sh, which whitelists the name (run_task.sh:27)
//     -> AccountingDocumentsRunner.update_accounting_document_payload()
//        (accounting_documents_runner.ex:138)
//     -> UpdateAccountingDocumentPayloadTask.run/0, which reads both parameters with
//        System.get_env/1 and does `Ecto.Changeset.change(%{payload_base64: …}) |> Repo.update()`
//
// ⚠ That task validates NOTHING. It does not decode the string, does not check it is
// base64, does not look at the document's type or state. Whatever you pass is what lands
// in the column. Its @moduledoc is also stale — it claims the payload is a
// `Events.Sales.SaleCreated.V1.Payload`; it is a `BillingDocument`.
const TASK_NAME = "update_accounting_document_payload";

// The deployment that carries the task. Production runs the web component; other
// namespaces have the plain one. Same split as the console component, and overridable
// because a redeploy is likelier than a change to this script.
function taskService(namespace) {
  return isProd(namespace) ? "accounting-documents-web" : "accounting-documents";
}

const EXIT_DATA = 1; // something in the data is wrong or unresolved
const EXIT_USAGE = 2; // the call was wrong, or approval was refused

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.exitCode = EXIT_USAGE;
  }
}

// --- the decoder that runs in the BEAM ---------------------------------------
//
// Elixir, evaluated by the release. Reads `id|base64` lines from stdin and writes one
// `ROW <json>` line per document to stdout.
//
// `Plug.Crypto.non_executable_binary_to_term/1` rather than `:erlang.binary_to_term/1`:
// it refuses anonymous functions and other executable terms, and it is what production
// itself uses to read these payloads (submission.ex:255). This input comes out of our own
// database so either would do, but a decoder that cannot be talked into evaluating
// something is the better habit.
//
// `pretty: true` is the only rendering, because it is the one anyone actually reads. The
// cost is that the term spans lines, so the CSV has more physical lines than records and
// cannot be grepped line-by-line — use a real CSV reader, or `grep -z`. On the wire that
// costs nothing: JSON escapes the newlines, so the decoder's own output stays strictly one
// line per document regardless.
//
// Each input line is `id|previous_receipt_number|base64`. An empty middle field means
// "decode only" — that is what a standalone run sends, and what an UNMATCHED credit note
// gets, since there is no invoice to point at.
//
// THE PATCH. `%{doc | previous_receipt_number: ref}` is a map update, not a rebuild: it
// preserves every untouched field and raises on a typo'd key rather than quietly adding
// one. The re-encoded base64 will NOT be byte-identical to the original even when the
// field is unchanged — map key order is not preserved by term_to_binary — so length and
// md5 are useless as correctness checks. These three assertions are used instead, and they
// run HERE, on the same VM that produced the bytes, because the output is destined for a
// production write:
//
//   round_trip_ok      decoding the new base64 yields exactly the patched term
//   only_field_changed nothing but previous_receipt_number differs from the original
//   was_nil            the field was empty beforehand, so nothing is being overwritten
//
// Node refuses to emit a row whose first two assertions failed. `was_nil` is reported
// rather than enforced — a re-run over an already-patched document is not an error.
//
// try/rescue is per document: one undecodable payload should cost you that row, not the
// other thirty-three.
const DECODER = `
opts = [pretty: true, width: 110, limit: :infinity, printable_limit: :infinity]
decode = fn b64 ->
  b64 |> String.trim() |> Base.decode64!() |> Plug.Crypto.non_executable_binary_to_term()
end

IO.read(:stdio, :eof)
|> String.split("\\n", trim: true)
|> Enum.each(fn line ->
  [id, prev, b64] = String.split(line, "|", parts: 3)

  row =
    try do
      doc = decode.(b64)
      base = %{id: id, pretty: inspect(doc, opts)}

      case prev do
        "" ->
          base

        ref ->
          patched = %{doc | previous_receipt_number: ref}
          new_b64 = patched |> :erlang.term_to_binary() |> Base.encode64()

          Map.merge(base, %{
            previous_receipt_number: ref,
            modified_pretty: inspect(patched, opts),
            new_b64: new_b64,
            round_trip_ok: decode.(new_b64) == patched,
            only_field_changed:
              Map.delete(patched, :previous_receipt_number) ==
                Map.delete(doc, :previous_receipt_number),
            was_nil: is_nil(doc.previous_receipt_number)
          })
      end
    rescue
      e -> %{id: id, error: Exception.message(e)}
    end

  IO.puts("${ROW_PREFIX}" <> Jason.encode!(row))
end)
`;

// --- colour ------------------------------------------------------------------
//
// Same convention as the other scripts here: cyan for SQL, yellow for a command you
// could run yourself, bright white for section headers, faint for progress chatter. Off
// when stdout isn't a terminal or when NO_COLOR is set (https://no-color.org).

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

// Echo a statement before it runs, indented and cyan. This script reads production, so
// what it asks for should never be a mystery.
function echoSql(label, sql) {
  const shown =
    sql.length > SQL_ECHO_LIMIT
      ? `${sql.slice(0, SQL_ECHO_LIMIT)}\n… (${sql.length - SQL_ECHO_LIMIT} more chars)`
      : sql;

  output.write(`  ${c.faint(label)}\n`);
  for (const line of shown.split("\n")) output.write(`    ${c.sql(line)}\n`);
}

// --- the local BEAM ----------------------------------------------------------
//
// The decode runs in the service's own checkout: `mix run --no-start -e '<decoder>'` with the
// app-accounting-documents umbrella as cwd. `--no-start` compiles if needed and puts every
// app's modules on the code path — BillingDocument, Decimal, Plug.Crypto, Jason — but starts
// nothing: no Repo, no database, no network. The payloads are the only production data it
// ever sees, and they arrive on stdin.
//
// The checkout is found through ACCOUNTING_DOCUMENTS_DIR, then --app-dir, then the sibling
// repo next to ops/ (…/repos/orion/app-accounting-documents/src). It must have its deps
// fetched (`mix deps.get`) — this script never fetches or writes anything there.
const DEFAULT_APP_DIR =
  process.env.ACCOUNTING_DOCUMENTS_DIR ||
  path.resolve(__dirname, "..", "..", "..", "orion", "app-accounting-documents", "src");

function appDefaults() {
  return { dir: DEFAULT_APP_DIR };
}

function onPath(cmd) {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
}

function findUp(start, file) {
  let dir = path.resolve(start);
  for (;;) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function asdfList(tool) {
  const r = spawnSync("asdf", ["list", tool], { encoding: "utf8" });
  if (r.status !== 0) return [];
  return r.stdout.split("\n").map((l) => l.replace(/[\s*]/g, "")).filter(Boolean);
}

// The checkout pins its toolchain in mise.toml, which asdf does not read, so under asdf a
// bare `mix` in that directory fails with "No version is set". When `mise` is absent and no
// ASDF_*_VERSION is already exported, pin from mise.toml: the exact version if it is
// installed, else the newest installed build of the same line (major.minor for Elixir,
// major for Erlang). With `mise` on PATH, mix is run through `mise x --` and mise decides.
function toolchainEnv(dir) {
  const env = { ...process.env };
  if (onPath("mise")) return env;
  const toml = findUp(dir, "mise.toml");
  if (!toml) return env;
  const text = fs.readFileSync(toml, "utf8");
  for (const [tool, key, depth] of [["elixir", "ASDF_ELIXIR_VERSION", 2], ["erlang", "ASDF_ERLANG_VERSION", 1]]) {
    if (env[key]) continue;
    const m = new RegExp(`^${tool}\\s*=\\s*"([^"]+)"`, "m").exec(text);
    if (!m) continue;
    const want = m[1];
    const installed = asdfList(tool);
    if (installed.includes(want)) {
      env[key] = want;
      continue;
    }
    const line = want.split(".").slice(0, depth).join(".");
    const candidates = installed
      .filter((v) => v.split(".").slice(0, depth).join(".") === line)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (candidates.length) env[key] = candidates[candidates.length - 1];
  }
  return env;
}

// Resolve --app-dir to the mix project (the umbrella lives in src/) and the environment mix
// needs. Refuses, with the flag to fix it, when there is no mix.exs to be found.
function resolveApp(app) {
  let dir = path.resolve(app.dir);
  if (!fs.existsSync(path.join(dir, "mix.exs")) && fs.existsSync(path.join(dir, "src", "mix.exs"))) {
    dir = path.join(dir, "src");
  }
  if (!fs.existsSync(path.join(dir, "mix.exs"))) {
    throw new UsageError(
      `No mix.exs at ${dir}. Point --app-dir (or ACCOUNTING_DOCUMENTS_DIR) at the app-accounting-documents checkout.`
    );
  }
  const mix = onPath("mise") ? ["mise", "x", "--", "mix"] : ["mix"];
  return { dir, mix, env: toolchainEnv(dir) };
}

// The mix command, echoed with the Elixir elided — the decoder is constant, so printing it
// every batch buries the part that varies.
function echoBeam(app, count) {
  output.write(
    `  ${c.faint(
      `decoding ${count} payload${count === 1 ? "" : "s"} in the service's own BEAM`
    )}\n` +
      `    ${c.cmd(`cd ${app.dir} && ${app.mix.join(" ")} run --no-start -e '<decoder>'`)}\n` +
      `    ${c.faint("payloads on stdin; one ROW <json> line back per document")}\n`
  );
}

// Run one batch through the local BEAM. Returns the ROW lines; everything else mix prints
// (compile progress, config warnings, Logger chatter) is discarded.
function runBeam(app, program, stdin) {
  const out = runCapture(app.mix[0], [...app.mix.slice(1), "run", "--no-start", "-e", program], {
    input: stdin,
    cwd: app.dir,
    env: app.env,
  });
  return out.split("\n").filter((line) => line.startsWith(ROW_PREFIX));
}


// --- prompting ---------------------------------------------------------------
//
// One readline for the whole run, with a line queue. The per-question createInterface
// pattern silently loses answers when stdin is a pipe: the second interface swallows
// lines the first had already buffered.

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

// Running out of input is an abort, never an implicit "accept the default" — a Ctrl-D, or
// a piped script one line short, must not answer a prompt for you.
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

// Numbered menu. Accepts the number, any of the option's aliases, or blank for the
// default. Re-asks up to 3 times on nonsense.
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

// --- shelling out ------------------------------------------------------------

function isProd(namespace) {
  return PROD_NAMESPACES.has(namespace.toLowerCase());
}

// The psql database environment for a given deploy namespace.
function psqlEnv(namespace) {
  return namespace === "production" ? "production" : namespace;
}

// maxBuffer is generous on purpose: a decoded term is a couple of KB and the pretty form
// several more, so a 200-document batch runs to megabytes. The default 1 MB would
// truncate it and the failure would look like missing documents.
function runCapture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${cmd} exited ${res.status}\n${res.stderr || ""}${res.stdout || ""}`.trim());
  }
  return res.stdout;
}

// Every statement this run executed, in order. See the note in match_credit_notes_to_invoices.js.
const EXECUTED = [];

// Read-only psql. -t -A -F| gives bare pipe-delimited rows; a NULL column comes back as
// an empty field, which is why every nullable column below is wrapped in coalesce() — an
// empty field is then unambiguous rather than "NULL or ''".
function psqlRead(env, db, sql) {
  echoSql(`houston psql ${env} ${db}`, sql);
  EXECUTED.push({ db, sql });

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

// Split psql output into per-row field arrays. `houston psql` prefixes its output with a
// correlation-id / timestamp preamble, so drop any line that doesn't have the expected
// field count.
//
// Safe here only because both columns read below are machine-generated — an id and
// base64. Anything free-text needs a different channel; see the header on why the BEAM
// answers in JSON.
function parseRows(out, fieldCount) {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => line.split("|"))
    .filter((fields) => fields.length === fieldCount);
}

function chunked(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// --- value guards ------------------------------------------------------------

function guardInt(value, what) {
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) throw new Error(`Expected an integer for ${what}, got: ${value}`);
  return s;
}

// The RFC 4648 standard alphabet, and nothing else. The emitted Houston command wraps this
// value in single quotes, and this is what makes that safe: base64 cannot contain a quote,
// a space or a shell metacharacter, so there is no way for a payload to break out of the
// quoting and become part of the command. Checked rather than assumed, because the command
// is meant to be pasted into a shell against production.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function guardBase64(value, what) {
  const s = String(value).trim();
  if (!BASE64_RE.test(s)) {
    throw new Error(`Expected base64 for ${what}, got something else (${s.length} chars)`);
  }
  return s;
}

// --- steps -------------------------------------------------------------------

// Step 1 — the ids as accounting_documents sees them. receipt_number is the printed
// reference (`CN/1107`); payload_base64 is the term. Both nullable, hence coalesce: an
// empty payload is a real state and is reported rather than sent to the decoder to fail.
//
// latest_tracker_id is read for the step AFTER the payload write, not for the decode.
// Patching the payload is only half the job: the document then has to be re-driven with
// `retry_sending_failed_accounting_documents`, which silently drops anything whose tracker
// is not `failed_to_send`/`rejected` and still reports success
// (retry_sending_failed_accounting_documents_action.ex:43-52 — FORCE=true does not bypass
// it). Putting that tracker back into an eligible state needs
// `update_einvoice_trackers_status -p E_INVOICE_TRACKER_IDS=<id>`, and this is the id it
// wants. Carrying it in the CSV means the whole sequence can be assembled from one file
// instead of a second query per document at the point you are already mid-runbook.
function fetchPayloads(env, ids) {
  const byId = new Map();

  for (const batch of chunked(ids, CHUNK)) {
    const idList = batch.map((id) => guardInt(id, "accounting_documents.id")).join(",");
    const sql =
      "SELECT ad.id::text, coalesce(ad.receipt_number, ''),\n" +
      "       coalesce(ad.document_type::text, ''), coalesce(ad.deleted_at::text, ''),\n" +
      "       coalesce(ad.latest_tracker_id::text, ''),\n" +
      "       coalesce(ad.payload_base64, '')\n" +
      "FROM accounting_documents ad\n" +
      `WHERE ad.id IN (${idList})\n` +
      "ORDER BY ad.id;";

    for (const f of parseRows(psqlRead(env, AD_DB, sql), 6)) {
      byId.set(f[0], {
        id: f[0],
        receiptNumber: f[1],
        documentType: f[2],
        deletedAt: f[3],
        // Empty when the document has no tracker at all — a real state, and a different
        // problem from a tracker in the wrong status, so it is not defaulted to anything.
        latestTrackerId: f[4],
        payloadBase64: f[5],
      });
    }
  }
  return byId;
}

// The reference is interpolated into a pipe-delimited line, so it may not contain a pipe
// or a newline. Production receipt numbers are of the form `INV/21396` and never do — but
// this value comes out of a database and ends up inside a document reported to a tax
// authority, so it is checked rather than assumed.
function guardReference(value) {
  const s = String(value).trim();
  if (!s) return "";
  if (/[|\r\n]/.test(s)) {
    throw new Error(`Refusing to send a reference containing a pipe or newline: ${JSON.stringify(s)}`);
  }
  return s;
}

// Step 2 — decode in the local BEAM, in batches. Returns id -> {pretty, …} or {error}.
function decodeLocally(app, docs) {
  const byId = new Map();

  for (const batch of chunked(docs, BEAM_CHUNK)) {
    echoBeam(app, batch.length);

    // `id|previous_receipt_number|base64`, one per line. The reference is guarded above
    // and base64 contains no pipe, so the decoder's split into three is unambiguous. An
    // empty middle field means decode without patching.
    const stdin = `${batch
      .map((d) => `${d.id}|${guardReference(d.previousReceiptNumber || "")}|${d.payloadBase64}`)
      .join("\n")}\n`;

    for (const line of runBeam(app, DECODER, stdin)) {
      let row;
      try {
        row = JSON.parse(line.slice(ROW_PREFIX.length));
      } catch (err) {
        throw new Error(`Could not parse a decoded row from the decoder: ${err.message}\n${line}`);
      }
      byId.set(String(row.id), row);
    }
  }
  return byId;
}

// --- output ------------------------------------------------------------------

const DASH = "—";

// Fixed-width table with a drawn grid. Plain box-drawing only, so it still copy-pastes
// into a ticket or a Slack code block unchanged.
function renderTable(headers, rows, align = []) {
  // Measure what the eye sees, not what the string holds: a coloured cell carries escape
  // bytes that padEnd would otherwise count as width.
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

// The CSV columns, defined once. One record per document — a decoded document is a tree,
// and flattening it into columns would mean choosing which fields matter. The whole term
// goes in instead, so nothing is lost and nothing has to be chosen.
//
// The three patch columns are empty on a decode-only run, and on any credit note the
// matrix could not match. `previous_receipt_number` is redundant with what is visible
// inside `modified_payload_pretty`, and it is here anyway: it is the value the whole
// exercise exists to produce, and reading it out of a 70-line term to check one field is
// a poor use of anyone's afternoon.
// Both documents are named, and both billing periods are given in full, because a
// cross-period match is a legitimate result here rather than an error — so the reader needs
// to see the two periods to judge it, not be told they differ.
//
// Note `credit_note_reference` was called `invoice_reference` in an earlier version, which
// was actively misleading: it holds `CN/1107`, the credit note's own reference. The matched
// invoice's reference now has that name, which is what anyone would assume it meant.
const HEADERS = [
  "accounting_document_id",
  "credit_note_reference",
  // Next to the document's own identifiers rather than beside the write command, because
  // it identifies the document's tracker — it is not part of the payload write and must
  // not read as though it were. What it is for is on fetchPayloads above.
  "latest_tracker_id",
  "cn_billing_start",
  "cn_billing_end",
  "invoice_reference",
  "inv_billing_start",
  "inv_billing_end",
  "decoded_payload_pretty",
  "previous_receipt_number",
  "modified_payload_pretty",
  "base64_new_payload",
  "houston_task_command",
  "decode_snippet",
];

function csvRow(row) {
  return [
    row.id,
    row.receiptNumber,
    row.latestTrackerId,
    row.cnBillingStart,
    row.cnBillingEnd,
    row.invoiceReference,
    row.invBillingStart,
    row.invBillingEnd,
    row.pretty,
    row.previousReceiptNumber,
    row.modifiedPretty,
    row.newB64,
    row.taskCommand,
    row.decodeSnippet,
  ];
}

// Paste-into-IEx form of this row's payload: assign it, decode it, print it. Saves
// hand-assembling the three lines around a 4 KB base64 every time you want to look at one.
//
// It carries the PATCHED payload, so what you get back is what a write would store — the
// original is in decoded_payload_pretty already.
function decodeSnippet(newB64) {
  if (!newB64) return "";

  return [
    `b64 = "${guardBase64(newB64, "the re-encoded payload")}"`,
    "",
    "doc = b64 |> Base.decode64!() |> Plug.Crypto.non_executable_binary_to_term()",
    "IO.puts(inspect(doc, pretty: true, limit: :infinity, printable_limit: :infinity))",
  ].join("\n");
}

// The command that would write this payload back. One document per invocation, because the
// task takes a single ACCOUNTING_DOCUMENT_ID — there is no batch form, and inventing one by
// looping in a shell would lose the ability to stop after the first.
//
// Written on one line so it survives a CSV cell and a copy-paste intact. The base64 is
// single-quoted: it contains `+`, `/` and often a trailing `=`, all of which a shell would
// otherwise be entitled to an opinion about. guardBase64 above is what makes one layer of
// quoting sufficient.
function houstonTaskCommand(opts, id, newB64) {
  if (!newB64) return "";

  const service = opts.taskService || taskService(opts.namespace);
  return (
    `houston task run ${service} --namespace ${opts.namespace} ${TASK_NAME}` +
    ` -p ACCOUNTING_DOCUMENT_ID=${guardInt(id, "accounting_documents.id")}` +
    ` -p PAYLOAD_BASE64='${guardBase64(newB64, "the re-encoded payload")}'` +
    " --no-tui -w"
  );
}


// --- CSV export --------------------------------------------------------------
//
// RFC 4180: a field holding a comma, a double quote or a newline is quoted, and any quote
// inside it is doubled. That is load-bearing here rather than defensive — the term column
// is pretty-printed, so it always contains newlines, and it quotes Elixir strings, so it
// always contains doubled quotes. The file therefore has far more physical lines than it
// has records and must be read with a real CSV parser, never split on "\n".

function csvCell(value) {
  // The em-dash is a display convention for "nothing". A spreadsheet wants an empty cell
  // instead, so it sorts and filters as absent rather than as text.
  const s = value === null || value === undefined || value === DASH ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function outputPath(namespace, extension) {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(process.cwd(), `decoded-payloads-${namespace}-${day}.${extension}`);
}

function writeCsv(namespace, rows) {
  const file = outputPath(namespace, "csv");
  const lines = [HEADERS, ...rows.map(csvRow)].map((cells) => cells.map(csvCell).join(","));

  // Trailing newline: POSIX text file, and it stops the last record being flagged as
  // truncated by anything strict.
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

// The statements this run executed, as a runnable file beside the CSV. Not a description of
// them and not a curated copy — the actual SQL, so the CSV can be checked rather than
// trusted. `extra` carries the matrix's statements when this ran as `--mode decode`, which
// executes those first.
function writeSql(namespace, extra = []) {
  const file = outputPath(namespace, "sql");
  const all = [...extra, ...EXECUTED];

  const lines = [
    `-- SQL executed by decode_payloads, namespace ${namespace}`,
    `-- ${all.length} statement${all.length === 1 ? "" : "s"}, in order. Read-only.`,
    "--",
    "-- Run against the database named above each one:",
    "--   houston psql <namespace> <database>",
    "",
  ];
  all.forEach((q, i) => {
    lines.push(`-- ${i + 1}. ${q.db}`, q.sql, "");
  });

  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

// The index table. The terms themselves are thousands of characters, so they cannot live
// in a table cell — they are printed in full underneath instead.
//
// `previous_receipt_number` gets a column because it is the point of a patching run: the
// whole result is checkable at a glance without reading any terms.
function printIndex(rows) {
  // Both periods, so a cross-period match is visible here and not only in the matrix above.
  const period = (start, end) => (start && end ? `${start} → ${end}` : DASH);

  output.write(`\n${c.head("── Decoded ─────────────────────────────────────────────")}\n`);
  output.write(
    `${renderTable(
      [
        "accounting_document_id",
        "Credit note",
        "Tracker",
        "CN period",
        "Invoice",
        "INV period",
        "Period",
        "Patched",
      ],
      rows.map((r) => {
        const same =
          r.cnBillingStart && r.invBillingStart
            ? r.cnBillingStart === r.invBillingStart && r.cnBillingEnd === r.invBillingEnd
            : null;
        return [
          r.id,
          r.receiptNumber || DASH,
          // A document with no tracker cannot be re-driven at all, so the gap is shown
          // rather than left blank.
          r.latestTrackerId || c.warn("none"),
          period(r.cnBillingStart, r.cnBillingEnd),
          r.invoiceReference || DASH,
          period(r.invBillingStart, r.invBillingEnd),
          same === null ? DASH : same ? "same" : c.warn("DIFFERENT"),
          r.newB64 ? c.ok("yes") : c.faint("decode only"),
        ];
      }),
      ["r", "", "r", "", "", "", "", ""]
    )}\n`
  );
}

// The pretty rendering, in full, per document. This is the point of the script — the CSV
// is for later, the terminal is for now. On a patching run the patched term is what you
// want to read, so that is what is shown; the original is in the CSV either way.
function printTerms(rows) {
  for (const row of rows) {
    const ref = row.receiptNumber ? ` ${row.receiptNumber}` : "";
    const patch = row.previousReceiptNumber
      ? c.ok(`  previous_receipt_number → ${row.previousReceiptNumber}`)
      : "";
    output.write(`\n${c.head(`── ${row.id}${ref} `.padEnd(56, "─"))}${patch}\n`);
    output.write(`${row.modifiedPretty || row.pretty}\n`);
  }
}

// Why a supplied id produced no decoded term. Each reason is a different mistake and
// wants a different fix, so they never collapse into one "invalid id" bucket.
function printRejects(rejects) {
  output.write(`\n${c.head("── Not decoded ─────────────────────────────────────────")}\n`);
  output.write(
    `${renderTable(
      ["accounting_documents.id", "Why"],
      rejects.map((r) => [r.id, c.bad(r.reason)])
    )}\n`
  );
}

// The write, spelled out but never run. This script has no write path; these are commands
// for a human to run, one document at a time, having read the payload above.
//
// The base64 is elided on screen — it is thousands of characters and would bury everything
// else. The CSV column carries the whole thing, which is where you copy it from.
function printWriteCommands(rows, opts) {
  const writable = rows.filter((r) => r.taskCommand);
  if (!writable.length) return;

  const prod = isProd(opts.namespace);

  output.write(`\n${c.head("── The write — NOT run by this script ──────────────────")}\n`);
  output.write(
    `  ${c.faint(
      `${writable.length} command${writable.length === 1 ? "" : "s"}, one per document. ` +
        "Full base64 is in the CSV's houston_task_command column."
    )}\n`
  );
  if (prod) {
    output.write(
      `  ${c.warn(
        "⚠ update_accounting_document_payload validates nothing: it does not decode the\n" +
          "    string, check it is base64, or look at the document. Whatever you pass lands.\n" +
          "    Keep the original payload — feeding it back through the same task is the only\n" +
          "    rollback."
      )}\n`
    );
  }

  for (const row of writable) {
    const elided = row.taskCommand.replace(
      /-p PAYLOAD_BASE64='[^']*'/,
      `-p PAYLOAD_BASE64='<${row.newB64.length} chars — see CSV>'`
    );
    output.write(`\n  ${c.faint(`${row.id}  ${row.receiptNumber || ""}`.trim())}\n`);
    output.write(`    ${c.cmd(elided)}\n`);
  }
}

function printSummary(rows, rejects) {
  const total = rows.length + rejects.length;
  const patched = rows.filter((r) => r.newB64).length;

  const parts = [`${rows.length} decoded`];
  // Only worth a word when patching was asked for at all. On a decode-only run the count
  // is zero by design, and reporting "0 patched" would read as a failure.
  if (patched) parts.push(c.ok(`${patched} patched`));
  if (rows.length - patched && patched) {
    parts.push(c.warn(`${rows.length - patched} unpatched`));
  }
  if (rejects.length) parts.push(c.bad(`${rejects.length} not decoded`));

  output.write(
    `\n  ${parts.join(", ")} ${c.faint(`(${total} id${total === 1 ? "" : "s"} supplied)`)}\n`
  );
}

// --- interactive steps -------------------------------------------------------

async function askNamespace() {
  const raw = (await ask(`\nNamespace [${DEFAULT_NAMESPACE}]: `)).trim();
  return raw || DEFAULT_NAMESPACE;
}

// Shared by --ids and the prompt, so both accept the same shapes and reject the same way.
// Commas, whitespace or both; deduped with the order preserved.
function parseIds(raw) {
  const tokens = String(raw)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const invalid = tokens.filter((t) => !/^\d+$/.test(t));
  if (invalid.length) {
    throw new UsageError(`Not integer accounting_documents.id values: ${invalid.join(", ")}`);
  }
  if (!tokens.length) throw new UsageError("No accounting document ids given.");
  return [...new Set(tokens)];
}

// Accepts commas, whitespace, or one id per line. A blank line ends the list, so a paste
// straight out of a spreadsheet works.
async function askDocumentIds() {
  output.write(`\n${c.head("accounting_documents ids")}\n`);
  output.write(`  ${c.faint("comma or newline separated; a blank line ends the list")}\n`);

  for (let attempt = 0; attempt < 3; attempt++) {
    const collected = [];
    for (;;) {
      const line = await ask("  > ");
      if (!line.trim()) break;
      collected.push(line);
    }

    // Same parser as --ids, so both paths accept and reject identically. Its errors are
    // fatal on the command line but only a re-ask here.
    try {
      return parseIds(collected.join(","));
    } catch (err) {
      output.write(`  ${c.bad(err.message)}\n`);
    }
  }
  throw new UsageError("No usable accounting document ids given.");
}

// The gate, before ANY data access. Read-only throughout, but it is still real production
// data, so the target — and the checkout that will decode it — is spelled out and approved first.
async function confirmDataAccess(opts, env, app, count) {
  const namespace = opts.namespace;
  const prod = isProd(namespace);

  output.write(`\n${c.head("── About to read real data ─────────────────────────────")}\n`);
  output.write(`  namespace : ${namespace}${prod ? "   ⚠  PRODUCTION" : ""}\n`);
  output.write(`  psql env  : ${env}\n`);
  output.write(`  database  : ${AD_DB}\n`);
  output.write(`  reading   : ${count} document id${count === 1 ? "" : "s"}\n`);
  output.write(`  decode in : ${app.dir}   (local BEAM, mix run --no-start — no DB access)\n`);
  output.write("  access    : SELECT only — this script has no write path\n");

  // --yes IS the approval for reads. The target is still printed above, so an unattended
  // run leaves the same record of what it touched.
  if (opts.yes) {
    output.write(`  approved  : ${c.faint("--yes (non-interactive)")}\n`);
    return true;
  }

  // The prod/non-prod asymmetry lives in the DEFAULT: in production a bare Enter
  // cancels, so it takes a deliberate keystroke to read real production data.
  return askChoice("Read and decode these payloads?", [
    { label: "Yes — run it", aliases: ["yes", "y", "read"], value: true, default: !prod },
    {
      label: "Cancel — nothing is read",
      aliases: ["no", "n", "cancel", "abort"],
      value: false,
      default: prod,
    },
  ]);
}

// --- the mode ----------------------------------------------------------------

// The entry point match_credit_notes_to_invoices.js calls. It has already parsed the ids and confirmed
// the read, so this does the work and nothing else — no prompting, no gate. Running this
// file directly goes through main() below, which supplies both.
//
// `opts` is { namespace, app: {dir} }.
//
// `patches` is an optional Map of accounting_documents.id -> { previousReceiptNumber },
// supplied by match_credit_notes_to_invoices.js from its matrix. Without it this decodes and nothing
// more, which is all a standalone run can honestly do: the reference to write comes from
// matching a credit note to its invoice, and that is the other file's job.
function runDecode(opts, env, ids, patches = new Map()) {
  const app = resolveApp(opts.app || appDefaults());

  // 1. The payloads.
  const docs = fetchPayloads(env, ids);

  const rejects = [];
  const decodable = [];
  for (const id of ids) {
    const doc = docs.get(id);
    if (!doc) {
      rejects.push({ id, reason: "NOT FOUND — no accounting_documents row with this id" });
    } else if (!doc.payloadBase64) {
      rejects.push({ id, reason: "NO PAYLOAD — payload_base64 is NULL or empty" });
    } else {
      // Everything the matrix worked out about this credit note travels with it. Empty on a
      // standalone run, which has no matrix.
      decodable.push({ ...doc, ...(patches.get(id) || {}) });
    }
  }

  const deleted = decodable.filter((d) => d.deletedAt);
  if (deleted.length) {
    output.write(
      `\n  ${c.warn(`Note: ${deleted.length} document(s) are soft-deleted:`)} ` +
        `${deleted.map((d) => d.id).join(", ")}\n`
    );
  }

  if (!decodable.length) {
    if (rejects.length) printRejects(rejects);
    output.write(`\n  ${c.bad("Nothing to decode.")}\n`);
    return EXIT_DATA;
  }

  // 2. Decode.
  const decoded = decodeLocally(app, decodable);

  const rows = [];
  const alreadySet = [];
  for (const doc of decodable) {
    const result = decoded.get(doc.id);
    if (!result) {
      rejects.push({ id: doc.id, reason: "NO ANSWER — the decoder returned no row for this id" });
      continue;
    }
    if (result.error) {
      rejects.push({ id: doc.id, reason: `DECODE FAILED — ${result.error}` });
      continue;
    }

    // A patched row that fails either assertion is dropped rather than reported with a
    // caveat: its base64 is a candidate for a production write, and half-verified bytes
    // are worse than none. Both are computed in the VM that produced them.
    if (result.new_b64) {
      if (!result.round_trip_ok) {
        rejects.push({
          id: doc.id,
          reason: "RE-ENCODE UNSOUND — the new base64 does not decode back to the patched term",
        });
        continue;
      }
      if (!result.only_field_changed) {
        rejects.push({
          id: doc.id,
          reason: "PATCH TOO BROAD — something other than previous_receipt_number changed",
        });
        continue;
      }
      // Not fatal: re-running over a document that was patched earlier is legitimate. But
      // it means the printed "before" is not the pristine document, so say so.
      if (!result.was_nil) alreadySet.push(doc.id);
    }

    rows.push({
      ...doc,
      pretty: result.pretty,
      previousReceiptNumber: result.previous_receipt_number || "",
      modifiedPretty: result.modified_pretty || "",
      newB64: result.new_b64 || "",
      taskCommand: houstonTaskCommand(opts, doc.id, result.new_b64),
      decodeSnippet: decodeSnippet(result.new_b64),
    });
  }

  // 3. Report.
  if (rows.length) {
    printIndex(rows);
    printTerms(rows);
  }
  if (alreadySet.length) {
    output.write(
      `\n  ${c.warn(
        `Note: ${alreadySet.length} document(s) already had a previous_receipt_number, ` +
          "now overwritten:"
      )} ${alreadySet.join(", ")}\n`
    );
  }
  if (rejects.length) printRejects(rejects);
  printWriteCommands(rows, opts);
  printSummary(rows, rejects);

  // The CSV is this mode's deliverable, so it is written unless explicitly refused —
  // there is no prompt, unlike the matrix's. `--no-csv` still has to mean something,
  // though: a flag that is quietly ignored is worse than one that doesn't exist.
  if (rows.length && opts.csv !== false) {
    output.write(`  ${c.faint("csv:")} ${writeCsv(opts.namespace, rows)}\n`);
    output.write(`  ${c.faint("sql:")} ${writeSql(opts.namespace, opts.executedSql)}\n`);
  } else if (rows.length) {
    output.write(`  ${c.faint("csv: skipped (--no-csv)")}\n`);
  }

  return rejects.length ? EXIT_DATA : 0;
}

// --- standalone --------------------------------------------------------------

function usage() {
  console.log(`decode_payloads — decode accounting_documents.payload_base64 to CSV

Usage:
  ./decode_payloads.js [options]

Options:
  -n, --namespace <ns>      namespace the payloads are READ from (default ${DEFAULT_NAMESPACE})
      --ids <list>          accounting_documents.id values, comma or space separated
      --app-dir <path>      app-accounting-documents checkout that DECODES
                            (default ${DEFAULT_APP_DIR}; env ACCOUNTING_DOCUMENTS_DIR)
      --task-service <svc>  deployment named in the emitted Houston write command
                            (default accounting-documents-web on production)
  -y, --yes                 approve the read without prompting
  -h, --help                this text

Anything not passed is prompted for. For a fully non-interactive run supply --ids and --yes.

  ./decode_payloads.js
  ./decode_payloads.js --ids 4836650,4762882 --yes

payload_base64 is an Erlang term, so decoding it needs a BEAM: the payloads are read from
production and decoded locally by 'mix run --no-start' in the app-accounting-documents
checkout, which loads the app's modules but starts nothing and never sees a database. Writes decoded-payloads-<namespace>-<date>.csv, one record per document.

DECODE ONLY. To also patch previous_receipt_number with the invoice each credit note
credits, run it through the matrix instead:

  ./match_credit_notes_to_invoices.js --mode decode --ids 4836650 --yes

The reference comes from matching a credit note to its invoice, which a bare document id
cannot tell you — so the patch columns are empty on a standalone run rather than guessed.

Read-only: one SELECT, a pure-function decode, and a CSV. No write path.

Exit codes: 0 all decoded, 1 anything not decoded, 2 bad invocation or refused.`);
}

function parseArgs(argv) {
  const opts = {
    namespace: DEFAULT_NAMESPACE,
    namespaceGiven: false,
    ids: null,
    app: appDefaults(),
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.namespaceGiven && input.isTTY) opts.namespace = await askNamespace();
  const env = psqlEnv(opts.namespace);

  // The ids have no default — there is nothing sensible to guess — so say so plainly
  // rather than let the prompt die on a closed stdin with a generic message.
  if (!opts.ids && !input.isTTY) {
    throw new UsageError("--ids is required when there is no terminal to prompt on.");
  }
  const ids = opts.ids || (await askDocumentIds());

  if (!(await confirmDataAccess(opts, env, resolveApp(opts.app), ids.length))) {
    output.write("\n  Cancelled. Nothing was read.\n");
    return EXIT_USAGE;
  }

  return runDecode(opts, env, ids);
}

// Importable by match_credit_notes_to_invoices.js, runnable on its own. The two paths share every line
// below the gate — there is no second implementation to keep in step.
module.exports = { runDecode, appDefaults, resolveApp, DEFAULT_APP_DIR };

if (require.main === module) {
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
}
