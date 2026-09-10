#!/usr/bin/env node
//
// patch_invoice_payloads — decode an invoice's payload_base64, patch it, get the runbook.
//
// `accounting_documents.payload_base64` is
//
//   Base.encode64(:erlang.term_to_binary(%AccountingDocuments.Structs.BillingDocument{}))
//
// written once at document creation (create_accounting_document_and_tracker_action.ex:235).
// Every value starts `g3` — 0x83, the Erlang External Term Format version byte — so nothing
// but a BEAM can read it. ../edit_document_payload/AGENTS.md is the by-hand runbook: pull the
// base64 with psql, open an IEx shell, paste it in, read the inspect output, edit, re-encode,
// then work out which of four Houston tasks the document actually needs. Fine once. Tedious
// and error-prone the second time, and the errors are silent ones.
//
// This automates both halves for `document_type = 'invoice'` documents:
//
//   --mode decode   read the payloads, decode them in the service's own BEAM, write a CSV.
//   --mode patch    apply an Elixir patch expression, verify the bytes, and emit the exact
//                   remediation sequence this document needs — conditional on its country,
//                   its persisted line items and its tracker's current state.
//
// WHY A SEPARATE SCRIPT FROM ../match_credit_notes_to_invoices/decode_payloads.js. That one does the same
// three steps, but its patch is one literal — `%{doc | previous_receipt_number: ref}` — and
// its fatal assertion `only_field_changed` names that field explicitly. Neither generalises
// to an arbitrary fix. Its CSV columns are credit-note-shaped too. The plumbing below is
// copied from it rather than imported, which is the house convention: one directory, one
// entrypoint, no shared library to drift under either caller.
//
// WHY LOCALLY, IN THE SERVICE'S CHECKOUT. Decoding is a pure function of the bytes, so it
// needs a BEAM with the app's modules and nothing else. The app-accounting-documents checkout
// next door has exactly that: `mix run --no-start` compiles if needed, loads every umbrella
// app's modules and starts none of them — no Repo, no database, no network. It replaces the
// earlier approach of borrowing a staging pod through `houston console … eval`, which needed
// cluster exec rights and a release path that moved with every redeploy.
//
// WHY `--no-start`. Starting the application would connect Repos and consumers; a decode has
// no use for any of it, and a script that reads production payloads should not also be
// pointing a local application at anything.
//
// WHY THE PAYLOADS GO IN ON STDIN. base64 contains `+`, `/` and `=`, and a payload is
// multiple KB — argv is the wrong channel on both counts. `IO.read(:stdio, :eof)` inside the
// evaluated program reads a piped payload correctly.
//
// WHY THE BEAM ANSWERS IN JSON. The answer itself is Elixir — an `inspect`ed term — but it
// needs an envelope, and every obvious delimiter appears inside the payload. Party names are
// free text from provider records and contain literal pipes; addresses carry commas; a
// pretty-printed term is full of newlines. JSON escapes exactly those, so the decoder emits
// one `ROW <json>` line per document and Node unwraps it. The prefix also discards everything
// else mix prints — compile progress, config warnings, Logger chatter.
//
// SAFETY
//   - Read-only. SELECTs, a pure-function decode in a local BEAM that starts no application,
//     and files in the working directory. No `houston psql --write`, no `houston task run`,
//     ever.
//   - Every statement, every mix command, and the whole patch expression are echoed before
//     anything runs.
//   - A confirmation gate before the first read; production defaults to Cancel.
//   - Ids are validated as integers and base64 against RFC 4648 before either reaches a
//     command line.
//   - The original payload of every document is saved to originals/<id>.b64. That file is the
//     only rollback there is.
//
// Usage:
//   ./patch_invoice_payloads.js                                    fully interactive
//   ./patch_invoice_payloads.js --ids 4687595,4762930 --yes         decode only
//   ./patch_invoice_payloads.js --ids 4687595 --patch-file fix.exs --yes
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

const MODES = ["decode", "patch"];

// Both modes are read-only. The set is the enforcement mechanism, not a description: a mode
// not on it refuses to run without a terminal, in every namespace, so whoever adds a write
// mode gates it by default rather than by remembering to.
const READ_ONLY_MODES = new Set(["decode", "patch"]);

// An IN(...) list of thousands of ids makes for an unwieldy statement and an unreadable echo.
const CHUNK = 500;

// Documents per mix invocation. Each `mix run` boots a VM and loads the umbrella, several
// seconds a time, so batching is the point — but an unbounded batch means an unbounded term
// list in memory and one enormous blob of output.
const BEAM_CHUNK = 200;

const ROW_PREFIX = "ROW ";

// Only `invoice` is in scope. The enum has four values (enums.ex:71-78) and the other three
// are a different problem: a credit note belongs to ../match_credit_notes_to_invoices, and the two
// onboarding types carry a differently-shaped payload entirely.
const WANTED_DOCUMENT_TYPE = "invoice";

// The two tracker states `retry_sending_failed_accounting_documents` will act on. Anything
// else is silently dropped from its input list and the task still reports success
// (retry_sending_failed_accounting_documents_action.ex:43-52). FORCE=true does not bypass it.
const RETRY_UPLOAD_STATUS = "failed_to_send";
const RETRY_REVIEW_STATUS = "rejected";

// Countries whose documents get rows in einvoicing_accounting_document_line_items, and where
// a payload edit that shifts line order therefore has to delete them first — see §6 of
// ../edit_document_payload/AGENTS.md. Currently IT only
// (create_accounting_document_and_tracker_action.ex:24).
const LINE_ITEM_COUNTRY_CODES = new Set(["IT"]);

// --- the writes, as commands you run yourself --------------------------------
//
// This script does not write. It emits the exact Houston invocations that would, so each one
// stays a deliberate act by a human who has read the payload first.
//
// ⚠ update_accounting_document_payload validates NOTHING: it does not decode the string,
// check that it is base64, or look at the document's type or state. It is
// `Ecto.Changeset.change(%{payload_base64: …}) |> Repo.update()`. Whatever you pass lands.
// Its @moduledoc is also stale — it claims the payload is an `Events.Sales.SaleCreated.V1`;
// it is a `BillingDocument`.
//
// All three task names are whitelisted in app-accounting-documents/src/run_task.sh, which is
// a `case` statement — an unlisted name exits 1 before any Elixir runs.
const TASK_PAYLOAD = "update_accounting_document_payload";
const TASK_TRACKER = "update_einvoice_trackers_status";
const TASK_RETRY = "retry_sending_failed_accounting_documents";

// The deployment that carries the tasks. Production runs the web component; other namespaces
// have the plain one. Overridable because a redeploy is likelier than a change to this script.
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
// Elixir, evaluated by `mix run --no-start -e` in the service's checkout. Reads `id|base64` lines from stdin and writes one
// `ROW <json>` line per document to stdout.
//
// `Plug.Crypto.non_executable_binary_to_term/1` rather than `:erlang.binary_to_term/1`: it
// refuses anonymous functions and other executable terms, and it is what production itself
// uses to read these payloads (submission.ex:255). This input comes out of our own database
// so either would do, but a decoder that cannot be talked into evaluating something is the
// better habit.
//
// `pretty: true` is the only rendering, because it is the one anyone actually reads. The cost
// is that the term spans lines, so the CSV has more physical lines than records and cannot be
// grepped line-by-line — use a real CSV reader. On the wire that costs nothing: JSON escapes
// the newlines, so the decoder's own output stays one line per document.
//
// try/rescue is per document: one undecodable payload should cost you that row, not the other.

const DECODER_PRELUDE = `
opts = [pretty: true, width: 110, limit: :infinity, printable_limit: :infinity]

decode = fn b64 ->
  b64 |> String.trim() |> Base.decode64!() |> Plug.Crypto.non_executable_binary_to_term()
end

bd = AccountingDocuments.Structs.BillingDocument
zero = Decimal.new(0)

# Reported, never enforced. all_lines/1 is (items || []) ++ (service_charges || []) and that
# fixed order is load-bearing — the GOBL builder numbers lines from it — so the count is worth
# seeing. Totals consistency is NOT guaranteed to hold before the patch either, which is why
# both are measured before and after and left for a human to compare.
totals = fn d ->
  lines = bd.all_lines(d)
  sum = Enum.reduce(lines, zero, fn l, acc -> Decimal.add(acc, l.total_gross || zero) end)
  gross = d.total_gross || zero

  %{
    line_count: length(lines),
    doc_gross: to_string(gross),
    lines_gross: to_string(sum),
    consistent: Decimal.eq?(gross, sum)
  }
end
`;

const DECODER_BODY = `
IO.read(:stdio, :eof)
|> String.split("\\n", trim: true)
|> Enum.each(fn line ->
  [id, b64] = String.split(line, "|", parts: 2)

  row =
    try do
      doc = decode.(b64)
      base = %{id: id, pretty: inspect(doc, opts), totals_before: totals.(doc)}

      if patch == nil do
        base
      else
        patched = patch.(doc, id)

        # Checked before anything else touches \`patched\`: a patch that returned nil, a bare
        # map, or some other struct would otherwise blow up in a less legible place.
        if !is_struct(patched, doc.__struct__) do
          Map.merge(base, %{still_struct: false})
        else
          new_b64 = patched |> :erlang.term_to_binary() |> Base.encode64()

          changed =
            doc
            |> Map.from_struct()
            |> Map.keys()
            |> Enum.filter(fn k -> Map.get(doc, k) != Map.get(patched, k) end)
            |> Enum.map(&to_string/1)

          Map.merge(base, %{
            still_struct: true,
            same_keys: Map.keys(patched) == Map.keys(doc),
            changed_fields: changed,
            modified_pretty: inspect(patched, opts),
            new_b64: new_b64,
            round_trip_ok: decode.(new_b64) == patched,
            lines_non_empty: bd.all_lines(patched) != [],
            totals_after: totals.(patched)
          })
        end
      end
    rescue
      e -> %{id: id, error: Exception.message(e)}
    end

  IO.puts("${ROW_PREFIX}" <> Jason.encode!(row))
end)
`;

// Assemble the program. The patch expression is a local file's contents, so it is joined
// by CONCATENATION and never interpolated into a template literal — a `${` or a backtick in
// the file would otherwise be read by JavaScript instead of Elixir. The finished string
// reaches mix through spawnSync's argv array, so there is no shell to quote against either.
//
// `_ = {doc, id}` suppresses Elixir's unused-variable warning when a patch expression
// mentions only one of them, which is the common case.
function buildDecoder(patchExpr) {
  const patch = patchExpr
    ? ["patch = fn doc, id ->", "  _ = {doc, id}", patchExpr, "end"].join("\n")
    : "patch = nil";

  return `${DECODER_PRELUDE}\n${patch}\n${DECODER_BODY}`;
}

// --- colour ------------------------------------------------------------------
//
// Same convention as the other scripts here: cyan for SQL, yellow for a command you could
// run yourself, bright white for section headers, faint for progress chatter. Off when stdout
// isn't a terminal or when NO_COLOR is set (https://no-color.org).

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

// Echo a statement before it runs, indented and cyan. This script reads production, so what
// it asks for should never be a mystery.
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
// every batch buries the part that varies. The patch expression is NOT elided; it is printed
// in full at the gate, before any of this runs.
function echoBeam(app, count, patching) {
  output.write(
    `  ${c.faint(
      `${patching ? "patching" : "decoding"} ${count} payload${count === 1 ? "" : "s"} in the service's own BEAM`
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
// One readline for the whole run, with a line queue. The per-question createInterface pattern
// silently loses answers when stdin is a pipe: the second interface swallows lines the first
// had already buffered.

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

// Running out of input is an abort, never an implicit "accept the default" — a Ctrl-D, or a
// piped script one line short, must not answer a prompt for you.
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

// Numbered menu. Accepts the number, any of the option's aliases, or blank for the default.
// Re-asks up to 3 times on nonsense.
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
// several more, and a patching run carries two of them plus the base64. The default 1 MB
// would truncate, and the failure would look like missing documents.
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

// Every statement this run executed, in order, so the CSV can be checked rather than trusted.
const EXECUTED = [];

// Read-only psql. -t -A -F| gives bare pipe-delimited rows; a NULL column comes back as an
// empty field, which is why every nullable column below is wrapped in coalesce() — an empty
// field is then unambiguous rather than "NULL or ''".
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
// correlation-id / timestamp preamble, so drop any line that doesn't have the expected field
// count.
//
// This is only safe because every column either query selects is machine-generated — an id,
// an enum, a uuid, an ISO timestamp, or a reference of the form `INV/21396`. None can contain
// the pipe. Party names, which DO contain literal pipes, are deliberately not selected here;
// they arrive from the decoder inside a JSON envelope instead.
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
// value in single quotes, and this is what makes that safe: base64 cannot contain a quote, a
// space or a shell metacharacter, so there is no way for a payload to break out of the
// quoting and become part of the command. Checked rather than assumed, because the command is
// meant to be pasted into a shell against production.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function guardBase64(value, what) {
  const s = String(value).trim();
  if (!BASE64_RE.test(s)) {
    throw new Error(`Expected base64 for ${what}, got something else (${s.length} chars)`);
  }
  return s;
}

// --- the patch file ----------------------------------------------------------
//
// An Elixir expression over two bound variables — `doc`, the decoded BillingDocument, and
// `id`, its accounting_documents.id as a string. It returns the patched document.
//
//   case id do
//     "4687595" -> %{doc | items: Enum.reject(doc.items, &(&1.line_item_id == 28408886))}
//     "4762930" -> %{doc | previous_receipt_number: "INV/18142"}
//   end
//
// Prefer `%{doc | …}` — a map update, not a struct rebuild. It preserves every untouched
// field and raises on a typo'd key rather than quietly adding one. Match items on
// `line_item_id`, never on name or position: it is the only stable key, and it is what the
// refund path uses to correlate lines later.
//
// This is arbitrary Elixir, evaluated in the local BEAM. That VM has no database access — it is
// borrowed purely as a runtime — but the expression is still printed in full at the
// confirmation gate, because approving it is the point of the gate.
function readPatchFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new UsageError(`Could not read the patch file ${file}: ${err.message}`);
  }

  if (!raw.trim()) {
    throw new UsageError(`The patch file ${file} is empty. It must be an expression over doc/id.`);
  }
  // A NUL cannot survive the trip through argv, and would truncate the program silently
  // rather than loudly.
  if (raw.includes("\0")) {
    throw new UsageError(`The patch file ${file} contains a NUL byte.`);
  }
  return raw.replace(/\s+$/, "");
}

// --- steps -------------------------------------------------------------------

// Read 1 — the documents, with everything that decides what the remediation looks like.
// Mirrors §2 of ../edit_document_payload/AGENTS.md, trimmed to the fields that drive a
// decision:
//
//   document_type   is this actually an invoice
//   deleted_at      soft-deleted documents are a real state, reported not assumed away
//   latest_tracker_id + review/upload status
//                   whether the re-drive is eligible at all, and which tracker to flip
//   country_code    whether the persisted line items have to be deleted first (IT only)
//   integration     whether service charges are reported as lines (:smart_receipts)
//
// `sale_id_64`, never `sale_id`: the int4 column is NULL on newer rows and the bigint holds
// the value. The Ecto schema hides this with `field(:sale_id, :integer, source: :sale_id_64)`
// (accounting_document.ex:26), so app code is unaffected — but SQL that reads `sale_id` makes
// a live document look broken.
function fetchDocuments(env, ids) {
  const byId = new Map();

  for (const batch of chunked(ids, CHUNK)) {
    const idList = batch.map((id) => guardInt(id, "accounting_documents.id")).join(",");
    const sql =
      "SELECT ad.id::text, ad.document_type::text, coalesce(ad.receipt_number, ''),\n" +
      "       coalesce(ad.einvoice_reference, ''), coalesce(ad.sale_id_64::text, ''),\n" +
      "       coalesce(ad.deleted_at::text, ''), coalesce(ad.latest_tracker_id::text, ''),\n" +
      "       coalesce(t.review_status::text, ''), coalesce(t.upload_status::text, ''),\n" +
      "       coalesce(ac.country_code, ''), coalesce(p.integration::text, ''),\n" +
      "       coalesce(ad.payload_base64, '')\n" +
      "FROM accounting_documents ad\n" +
      "LEFT JOIN e_invoice_trackers t ON t.id = ad.latest_tracker_id\n" +
      "LEFT JOIN account_configurations ac ON ac.id = ad.account_configuration_id\n" +
      "LEFT JOIN account_configuration_plugins p ON p.id = ad.account_configuration_plugin_id\n" +
      `WHERE ad.id IN (${idList})\n` +
      "ORDER BY ad.id;";

    for (const f of parseRows(psqlRead(env, AD_DB, sql), 12)) {
      byId.set(f[0], {
        id: f[0],
        documentType: f[1],
        receiptNumber: f[2],
        einvoiceReference: f[3],
        saleId: f[4],
        deletedAt: f[5],
        // Empty when the document has no tracker at all — a real state, and a different
        // problem from a tracker in the wrong status, so it is not defaulted to anything.
        latestTrackerId: f[6],
        reviewStatus: f[7],
        uploadStatus: f[8],
        countryCode: f[9],
        integration: f[10],
        payloadBase64: f[11],
        lineItems: [],
      });
    }
  }
  return byId;
}

// Read 2 — the persisted line items. This is the trap that makes payload surgery on an IT
// document more than a one-liner.
//
// `einvoicing_accounting_document_line_items` holds one row per line, and a resubmit will NOT
// rebuild them: `line_items_already_inserted?/2`
// (create_accounting_document_and_tracker_action.ex:197-201) sees existing rows and skips
// insertion. The AdE line-ref webhook then matches GOBL line index `i` to the stored `index`
// (invopop/it/smartreceipts/invoice.ex:137-158), so a payload whose lines shifted stamps the
// tax authority's refs onto the wrong rows. Silent until someone refunds the sale.
function fetchLineItems(env, ids, byId) {
  for (const batch of chunked(ids, CHUNK)) {
    const idList = batch.map((id) => guardInt(id, "accounting_documents.id")).join(",");
    const sql =
      "SELECT accounting_document_id::text, index::text, line_id::text,\n" +
      "       line_item_id::text, line_item_type::text,\n" +
      "       coalesce(external_reference_id, '')\n" +
      "FROM einvoicing_accounting_document_line_items\n" +
      `WHERE accounting_document_id IN (${idList})\n` +
      "ORDER BY accounting_document_id, index;";

    for (const f of parseRows(psqlRead(env, AD_DB, sql), 6)) {
      const doc = byId.get(f[0]);
      if (!doc) continue;
      doc.lineItems.push({
        index: f[1],
        lineId: f[2],
        lineItemId: f[3],
        lineItemType: f[4],
        externalReferenceId: f[5],
      });
    }
  }
}

// Step 3 — decode (and optionally patch) in the local BEAM, in batches.
function decodeLocally(app, docs, patchExpr) {
  const byId = new Map();
  const decoder = buildDecoder(patchExpr);

  for (const batch of chunked(docs, BEAM_CHUNK)) {
    echoBeam(app, batch.length, Boolean(patchExpr));

    // `id|base64`, one per line. base64 contains no pipe, so the decoder's split into two is
    // unambiguous — and unlike the credit-note script there is no free-text field riding
    // along, because the patch travels in the program rather than in the data.
    const stdin = `${batch.map((d) => `${d.id}|${d.payloadBase64}`).join("\n")}\n`;

    for (const line of runBeam(app, decoder, stdin)) {
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

// Fixed-width table with a drawn grid. Plain box-drawing only, so it still copy-pastes into a
// ticket or a Slack code block unchanged.
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

// The CSV columns, defined once. One record per document — a decoded document is a tree, and
// flattening it into columns would mean choosing which fields matter. The whole term goes in
// instead, so nothing is lost and nothing has to be chosen.
//
// Everything from `changed_fields` rightwards is empty on a decode-only run.
//
// `changed_fields` is where the credit-note script has `previous_receipt_number`, and it is
// the honest generalisation of it: with an unknown fix you cannot name the permitted field up
// front, but you can report exactly which ones moved — so the whole result is checkable at a
// glance without reading a 70-line term.
const HEADERS = [
  "accounting_document_id",
  "document_type",
  "receipt_number",
  "einvoice_reference",
  "sale_id",
  "deleted_at",
  // Next to the document's own identifiers rather than beside the write command, because it
  // identifies the document's TRACKER — it is not part of the payload write and must not read
  // as though it were. What it is for is in remediationRunbook below.
  "latest_tracker_id",
  "tracker_review_status",
  "tracker_upload_status",
  "country_code",
  "integration",
  "line_items",
  "decoded_payload_pretty",
  "totals_before",
  "changed_fields",
  "totals_after",
  "modified_payload_pretty",
  "base64_new_payload",
  "houston_task_command",
  "rollback_task_command",
  "remediation_runbook",
  "decode_snippet",
];

function csvRow(row) {
  return [
    row.id,
    row.documentType,
    row.receiptNumber,
    row.einvoiceReference,
    row.saleId,
    row.deletedAt,
    row.latestTrackerId,
    row.reviewStatus,
    row.uploadStatus,
    row.countryCode,
    row.integration,
    renderLineItems(row.lineItems),
    row.pretty,
    row.totalsBefore,
    row.changedFields,
    row.totalsAfter,
    row.modifiedPretty,
    row.newB64,
    row.taskCommand,
    row.rollbackCommand,
    row.runbook,
    row.decodeSnippet,
  ];
}

// `index:line_item_id` pairs. Enough to see at a glance whether a payload edit will shift the
// indexes these rows are keyed by; the full rows are printed as a table and are one SELECT
// away in the emitted .sql.
function renderLineItems(items) {
  if (!items || !items.length) return "";
  return items.map((li) => `${li.index}:${li.lineItemId}`).join(";");
}

function renderTotals(t) {
  if (!t) return "";
  const flag = t.consistent ? "consistent" : "INCONSISTENT";
  return `${t.line_count} line(s), doc ${t.doc_gross} vs lines ${t.lines_gross} — ${flag}`;
}

// Paste-into-IEx form of a payload: assign it, decode it, print it. Saves hand-assembling the
// three lines around a 4 KB base64 every time you want to look at one. It carries the PATCHED
// payload where there is one, so what you get back is what a write would store — the original
// is in decoded_payload_pretty already.
function decodeSnippet(b64) {
  if (!b64) return "";

  return [
    `b64 = "${guardBase64(b64, "the payload")}"`,
    "",
    "doc = b64 |> Base.decode64!() |> Plug.Crypto.non_executable_binary_to_term()",
    "IO.puts(inspect(doc, pretty: true, limit: :infinity, printable_limit: :infinity))",
  ].join("\n");
}

// The command that would write a payload back. One document per invocation, because the task
// takes a single ACCOUNTING_DOCUMENT_ID — there is no batch form, and inventing one by looping
// in a shell would lose the ability to stop after the first.
//
// Written on one line so it survives a CSV cell and a copy-paste intact. The base64 is
// single-quoted: it contains `+`, `/` and often a trailing `=`, all of which a shell would
// otherwise be entitled to an opinion about. guardBase64 is what makes one layer of quoting
// sufficient.
function payloadTaskCommand(opts, id, b64) {
  if (!b64) return "";

  const service = opts.taskService || taskService(opts.namespace);
  return (
    `houston task run ${service} --namespace ${opts.namespace} ${TASK_PAYLOAD}` +
    ` -p ACCOUNTING_DOCUMENT_ID=${guardInt(id, "accounting_documents.id")}` +
    ` -p PAYLOAD_BASE64='${guardBase64(b64, "the payload")}'` +
    " --no-tui -w"
  );
}

// Is this document's tracker in a state the retry will actually act on?
//
// `get_failed_or_rejected_document_ids/1` filters the input list down to
// `upload_status == :failed_to_send or review_status == :rejected`
// (retry_sending_failed_accounting_documents_action.ex:43-52). A document in neither state is
// silently dropped and the task still reports success — so this decides whether the runbook
// needs the status flip, and getting it wrong looks like the retry working.
function retryEligible(doc) {
  return doc.uploadStatus === RETRY_UPLOAD_STATUS || doc.reviewStatus === RETRY_REVIEW_STATUS;
}

// Whether the persisted line items have to be deleted before the re-drive. IT only, and only
// if there are rows to delete.
function needsLineItemDelete(doc) {
  return LINE_ITEM_COUNTRY_CODES.has(doc.countryCode) && doc.lineItems.length > 0;
}

// The remediation sequence for ONE document, assembled from what the two reads actually
// found. Conditional rather than boilerplate: steps 2 and 3 below are the ones people either
// forget or run unnecessarily, and both failure modes are silent.
//
// Emitted, never run. Nothing in this script executes any of it.
function remediationRunbook(opts, doc, newB64) {
  if (!newB64) return "";

  const service = opts.taskService || taskService(opts.namespace);
  const ns = opts.namespace;
  const id = guardInt(doc.id, "accounting_documents.id");
  const steps = [];

  const step = (title, body) => {
    steps.push(`# ${steps.length + 1}. ${title}\n${body}`);
  };

  step(
    "Write the patched payload",
    `${payloadTaskCommand(opts, doc.id, newB64)}\n` +
      "#    This task validates nothing — it does not decode the string or look at the\n" +
      "#    document. Whatever you pass lands. Rollback is rollback_task_command.\n" +
      "#    Verify it landed:\n" +
      `#      houston psql ${psqlEnv(ns)} ${AD_DB} -- -t -A -c "SELECT length(payload_base64), updated_at FROM accounting_documents WHERE id = ${id};"`
  );

  if (needsLineItemDelete(doc)) {
    step(
      `Delete the ${doc.lineItems.length} persisted line item row(s) — BEFORE the re-drive`,
      `# ⚠ Needs houston psql ${psqlEnv(ns)} ${AD_DB} --write (fresha-production-admin /\n` +
        "#   -on-call / -database-superusers). No Houston task covers this.\n" +
        `#   country_code is ${doc.countryCode}, so this document has rows in\n` +
        "#   einvoicing_accounting_document_line_items, and the resubmit will NOT rebuild them:\n" +
        "#   line_items_already_inserted?/2 sees existing rows and skips insertion. The AdE\n" +
        "#   webhook then matches GOBL line index i to the stored index, so if your patch\n" +
        "#   changed the line order or count, refs get stamped onto the wrong rows — silently,\n" +
        "#   until someone refunds the sale. Deleting lets the app rebuild them from the\n" +
        "#   edited payload, deriving index/line_id/line_item_id/line_item_type itself.\n" +
        `#   Current rows: ${renderLineItems(doc.lineItems) || "(none)"}\n` +
        "BEGIN;\n" +
        "SELECT count(*) FROM einvoicing_accounting_document_line_items\n" +
        `WHERE accounting_document_id = ${id};   -- expect ${doc.lineItems.length}\n` +
        "\n" +
        "DELETE FROM einvoicing_accounting_document_line_items\n" +
        `WHERE accounting_document_id = ${id};\n` +
        "COMMIT;"
    );
  }

  if (!retryEligible(doc)) {
    const tracker = doc.latestTrackerId;
    if (!tracker) {
      step(
        "⚠ NO TRACKER — the re-drive below cannot work",
        `# latest_tracker_id is NULL on ${id}, so there is nothing for\n` +
          `# ${TASK_TRACKER} to flip and nothing for ${TASK_RETRY}\n` +
          "# to select. Work out why the document has no tracker before going further; this\n" +
          "# script will not guess."
      );
    } else {
      step(
        "Make the tracker eligible for the re-drive",
        `houston task run ${service} --namespace ${ns} ${TASK_TRACKER} \\\n` +
          `  -p E_INVOICE_TRACKER_IDS=${guardInt(tracker, "e_invoice_trackers.id")} \\\n` +
          `  -p REVIEW_STATUS=${RETRY_REVIEW_STATUS} \\\n` +
          `  -p UPLOAD_STATUS=${RETRY_UPLOAD_STATUS} \\\n` +
          "  --no-tui -w\n" +
          `#    Tracker ${tracker} is currently ` +
          `{upload_status: ${doc.uploadStatus || "null"}, review_status: ${doc.reviewStatus || "null"}},\n` +
          `#    which is neither ${RETRY_UPLOAD_STATUS} nor ${RETRY_REVIEW_STATUS}, so\n` +
          `#    ${TASK_RETRY} would drop it from its input list\n` +
          "#    and still report success. FORCE=true does NOT bypass that filter."
      );
    }
  }

  step(
    "Re-drive the document",
    `houston task run ${service} --namespace ${ns} ${TASK_RETRY} \\\n` +
      `  -p ACCOUNTING_DOCUMENT_IDS=${id} \\\n` +
      "  -p FORCE=true \\\n" +
      "  -p OBAN_STORER_ENABLED=1 \\\n" +
      "  --no-tui -w\n" +
      "#    OBAN_STORER_ENABLED defaults to \"0\" and NOTHING is queued without it — the task\n" +
      "#    returns :ok having inserted no jobs. accounting-documents-web already sets \"1\",\n" +
      "#    so this is belt-and-braces; pass it anyway, the failure mode is a silent no-op.\n" +
      (retryEligible(doc)
        ? `#    Tracker is {upload_status: ${doc.uploadStatus || "null"}, review_status: ${doc.reviewStatus || "null"}} — already eligible.\n`
        : "") +
      "#    This moves the tracker to :corrected, which is NOT an eligible state. If you have\n" +
      "#    to run it a second time, do the status flip again first."
  );

  step(
    "Verify",
    `houston psql ${psqlEnv(ns)} ${AD_DB} -- -c "\n` +
      "SELECT id, review_status, upload_status, web_doc_id, created_at\n" +
      `FROM e_invoice_trackers WHERE accounting_document_id = ${id} ORDER BY id;"\n` +
      "\n" +
      `houston psql ${psqlEnv(ns)} ${AD_DB} -- -c "\n` +
      "SELECT id, index, line_id, line_item_id, external_reference_id\n" +
      "FROM einvoicing_accounting_document_line_items\n" +
      `WHERE accounting_document_id = ${id} ORDER BY index;"\n` +
      "\n" +
      `houston psql ${psqlEnv(ns)} ${AD_DB} -- -c "\n` +
      "SELECT id, external_invoice_reference, deleted_at\n" +
      `FROM e_invoice_compliance_records WHERE accounting_document_id = ${id};"\n` +
      "#    Approval is asynchronous — it arrives by webhook. {sent, approved} is the finish\n" +
      "#    line, not web_doc_id being populated. Watch /dd-logs accounting-documents\n" +
      `#    ${ns} in the meantime.`
  );

  return [
    `# Remediation for accounting_documents ${id}` +
      (doc.receiptNumber ? ` (${doc.receiptNumber})` : ""),
    `# ${steps.length} steps, in order. NOT run by this script.`,
    "",
    ...steps,
  ].join("\n\n");
}

// --- CSV export --------------------------------------------------------------
//
// RFC 4180: a field holding a comma, a double quote or a newline is quoted, and any quote
// inside it is doubled. That is load-bearing here rather than defensive — the term columns are
// pretty-printed, so they always contain newlines, and they quote Elixir strings, so they
// always contain doubled quotes. The file therefore has far more physical lines than it has
// records and must be read with a real CSV parser, never split on "\n".

function csvCell(value) {
  // The em-dash is a display convention for "nothing". A spreadsheet wants an empty cell
  // instead, so it sorts and filters as absent rather than as text.
  const s = value === null || value === undefined || value === DASH ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function outputPath(namespace, extension) {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(process.cwd(), `invoice-payloads-${namespace}-${day}.${extension}`);
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
// them and not a curated copy — the actual SQL, so the CSV can be checked rather than trusted.
function writeSql(namespace) {
  const file = outputPath(namespace, "sql");

  const lines = [
    `-- SQL executed by patch_invoice_payloads, namespace ${namespace}`,
    `-- ${EXECUTED.length} statement${EXECUTED.length === 1 ? "" : "s"}, in order. Read-only.`,
    "--",
    "-- Run against the database named above each one:",
    "--   houston psql <namespace> <database>",
    "",
  ];
  EXECUTED.forEach((q, i) => {
    lines.push(`-- ${i + 1}. ${q.db}`, q.sql, "");
  });

  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

// The original payloads, one file per document, no trailing newline — psql's stray "\n" is
// exactly what makes `Base.decode64!/1` raise, so it is stripped rather than preserved.
//
// This is the ONLY rollback there is. `decoded_payload_pretty` is a rendering, not bytes, and
// the re-encoded value is not byte-identical to the original even when nothing meaningful
// changed. It goes next to the CSV rather than in /tmp, which is cleared on reboot.
function writeOriginals(rows) {
  const dir = path.join(process.cwd(), "originals");
  fs.mkdirSync(dir, { recursive: true });

  for (const row of rows) {
    fs.writeFileSync(
      path.join(dir, `${guardInt(row.id, "accounting_documents.id")}.b64`),
      guardBase64(row.payloadBase64, "the original payload")
    );
  }
  return dir;
}

// The index table. The terms themselves are thousands of characters, so they cannot live in a
// table cell — they are printed in full underneath instead.
function printIndex(rows) {
  output.write(`\n${c.head("── Decoded ─────────────────────────────────────────────")}\n`);
  output.write(
    `${renderTable(
      [
        "accounting_document_id",
        "Reference",
        "Country",
        "Integration",
        "Tracker",
        "upload/review",
        "Retry",
        "Rows",
        "Changed",
      ],
      rows.map((r) => [
        r.id,
        r.receiptNumber || DASH,
        r.countryCode || DASH,
        r.integration || DASH,
        // A document with no tracker cannot be re-driven at all, so the gap is shown rather
        // than left blank.
        r.latestTrackerId || c.warn("none"),
        `${r.uploadStatus || DASH}/${r.reviewStatus || DASH}`,
        retryEligible(r) ? c.ok("eligible") : c.warn("needs flip"),
        needsLineItemDelete(r)
          ? c.warn(`${r.lineItems.length} — delete`)
          : String(r.lineItems.length),
        r.changedFields ? c.ok(r.changedFields) : c.faint("decode only"),
      ]),
      ["r", "", "", "", "r", "", "", "r", ""]
    )}\n`
  );
}

// The pretty rendering, in full, per document. This is the point of the script — the CSV is
// for later, the terminal is for now. On a patching run the patched term is what you want to
// read, so that is what is shown; the original is in the CSV either way.
function printTerms(rows) {
  for (const row of rows) {
    const ref = row.receiptNumber ? ` ${row.receiptNumber}` : "";
    const changed = row.changedFields ? c.ok(`  changed: ${row.changedFields}`) : "";
    output.write(`\n${c.head(`── ${row.id}${ref} `.padEnd(56, "─"))}${changed}\n`);
    if (row.totalsBefore) output.write(`  ${c.faint(`before: ${row.totalsBefore}`)}\n`);
    if (row.totalsAfter) output.write(`  ${c.faint(`after:  ${row.totalsAfter}`)}\n`);
    output.write(`${row.modifiedPretty || row.pretty}\n`);
  }
}

// The persisted line items, per document. Only shown where there are any — most countries
// have none, and an empty table reads as a problem.
function printLineItems(rows) {
  const withRows = rows.filter((r) => r.lineItems.length);
  if (!withRows.length) return;

  output.write(`\n${c.head("── Persisted line items ────────────────────────────────")}\n`);
  output.write(
    `${renderTable(
      ["accounting_document_id", "index", "line_id", "line_item_id", "type", "external_ref"],
      withRows.flatMap((r) =>
        r.lineItems.map((li) => [
          r.id,
          li.index,
          li.lineId,
          li.lineItemId,
          li.lineItemType,
          li.externalReferenceId || DASH,
        ])
      ),
      ["r", "r", "r", "r", "", ""]
    )}\n`
  );
  output.write(
    `  ${c.faint(
      "These do NOT follow the payload. If a patch changes line order or count on an IT\n" +
        "  document, they have to be deleted so the app rebuilds them — see the runbook."
    )}\n`
  );
}

// Why a supplied id produced no usable row. Each reason is a different mistake and wants a
// different fix, so they never collapse into one "invalid id" bucket.
function printRejects(rejects) {
  output.write(`\n${c.head("── Not usable ──────────────────────────────────────────")}\n`);
  output.write(
    `${renderTable(
      ["accounting_documents.id", "Why"],
      rejects.map((r) => [r.id, c.bad(r.reason)])
    )}\n`
  );
}

// The remediation, spelled out but never run. This script has no write path; these are
// commands for a human to run, one document at a time, having read the payload above.
//
// The base64 is elided on screen — it is thousands of characters and would bury everything
// else. The CSV columns carry the whole thing, which is where you copy it from.
function printRunbooks(rows, opts) {
  const writable = rows.filter((r) => r.runbook);
  if (!writable.length) return;

  output.write(`\n${c.head("── Remediation — NOT run by this script ────────────────")}\n`);
  output.write(
    `  ${c.faint(
      `${writable.length} document${writable.length === 1 ? "" : "s"}. Full base64 and the ` +
        "complete runbook are in the CSV."
    )}\n`
  );
  if (isProd(opts.namespace)) {
    output.write(
      `  ${c.warn(
        "⚠ update_accounting_document_payload validates nothing: it does not decode the\n" +
          "    string, check it is base64, or look at the document. Whatever you pass lands.\n" +
          "    The originals/ directory written below is the only rollback."
      )}\n`
    );
  }

  for (const row of writable) {
    output.write(`\n  ${c.faint(`${row.id}  ${row.receiptNumber || ""}`.trim())}\n`);
    const elided = row.runbook.replace(
      /-p PAYLOAD_BASE64='[^']*'/g,
      `-p PAYLOAD_BASE64='<${row.newB64.length} chars — see CSV>'`
    );
    for (const line of elided.split("\n")) {
      output.write(line.startsWith("#") ? `    ${c.faint(line)}\n` : `    ${c.cmd(line)}\n`);
    }
  }
}

function printSummary(rows, rejects) {
  const total = rows.length + rejects.length;
  const patched = rows.filter((r) => r.newB64).length;

  const parts = [`${rows.length} decoded`];
  // Only worth a word when patching was asked for at all. On a decode-only run the count is
  // zero by design, and reporting "0 patched" would read as a failure.
  if (patched) parts.push(c.ok(`${patched} patched`));
  if (rows.length - patched && patched) {
    parts.push(c.warn(`${rows.length - patched} unpatched`));
  }
  if (rejects.length) parts.push(c.bad(`${rejects.length} not usable`));

  output.write(
    `\n  ${parts.join(", ")} ${c.faint(`(${total} id${total === 1 ? "" : "s"} supplied)`)}\n`
  );
}

// --- interactive steps -------------------------------------------------------

async function askNamespace() {
  const raw = (await ask(`\nNamespace [${DEFAULT_NAMESPACE}]: `)).trim();
  return raw || DEFAULT_NAMESPACE;
}

async function askMode() {
  return askChoice("What do you want to do?", [
    {
      label: "decode — read the payloads and write them to a CSV",
      detail: "no fix needed yet; this is how you decide what the fix is",
      aliases: ["decode", "d"],
      value: "decode",
      default: true,
    },
    {
      label: "patch — apply a patch file, verify, and emit the remediation",
      detail: "needs --patch-file; still writes nothing",
      aliases: ["patch", "p"],
      value: "patch",
    },
  ]);
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

    // Same parser as --ids, so both paths accept and reject identically. Its errors are fatal
    // on the command line but only a re-ask here.
    try {
      return parseIds(collected.join(","));
    } catch (err) {
      output.write(`  ${c.bad(err.message)}\n`);
    }
  }
  throw new UsageError("No usable accounting document ids given.");
}

// The gate, before ANY data access. Read-only throughout, but it is still real production
// data, and on a patching run it is also the moment the patch expression gets approved — so
// that is printed here in full, before the BEAM ever sees it.
async function confirmDataAccess(opts, env, app, count, patchExpr) {
  const namespace = opts.namespace;
  const prod = isProd(namespace);

  output.write(`\n${c.head("── About to read real data ─────────────────────────────")}\n`);
  output.write(`  namespace : ${namespace}${prod ? "   ⚠  PRODUCTION" : ""}\n`);
  output.write(`  psql env  : ${env}\n`);
  output.write(`  database  : ${AD_DB}\n`);
  output.write(`  mode      : ${opts.mode}\n`);
  output.write(`  reading   : ${count} document id${count === 1 ? "" : "s"}\n`);
  output.write(`  decode in : ${app.dir}   (local BEAM, mix run --no-start — no DB access)\n`);
  output.write("  access    : SELECT only — this script has no write path\n");

  if (patchExpr) {
    output.write(`\n  ${c.head(`patch (${opts.patchFile}) — evaluated in the local BEAM:`)}\n`);
    output.write("    patch = fn doc, id ->\n");
    for (const line of patchExpr.split("\n")) output.write(`    ${c.cmd(line)}\n`);
    output.write("    end\n");
  }

  // --yes IS the approval for reads. The target is still printed above, so an unattended run
  // leaves the same record of what it touched.
  if (opts.yes) {
    output.write(`\n  approved  : ${c.faint("--yes (non-interactive)")}\n`);
    return true;
  }

  // The prod/non-prod asymmetry lives in the DEFAULT: in production a bare Enter cancels, so
  // it takes a deliberate keystroke to read real production data.
  return askChoice(patchExpr ? "Read and patch these payloads?" : "Read and decode these payloads?", [
    { label: "Yes — run it", aliases: ["yes", "y", "read"], value: true, default: !prod },
    {
      label: "Cancel — nothing is read",
      aliases: ["no", "n", "cancel", "abort"],
      value: false,
      default: prod,
    },
  ]);
}

// --- the run -----------------------------------------------------------------

function run(opts, env, ids, patchExpr) {
  const app = resolveApp(opts.app || appDefaults());

  // 1. The documents, and the line-item rows that do not follow their payloads.
  const docs = fetchDocuments(env, ids);
  fetchLineItems(env, ids, docs);

  const rejects = [];
  const decodable = [];
  for (const id of ids) {
    const doc = docs.get(id);
    if (!doc) {
      rejects.push({ id, reason: "NOT FOUND — no accounting_documents row with this id" });
    } else if (!doc.payloadBase64) {
      rejects.push({ id, reason: "NO PAYLOAD — payload_base64 is NULL or empty" });
    } else if (doc.documentType !== WANTED_DOCUMENT_TYPE && !opts.anyType) {
      rejects.push({
        id,
        reason: `NOT AN INVOICE — document_type is ${doc.documentType} (--any-type to override)`,
      });
    } else {
      decodable.push(doc);
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

  // 2. Decode, and patch if there is a patch.
  const decoded = decodeLocally(app, decodable, patchExpr);

  const rows = [];
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

    // A patched row that fails any structural assertion is DROPPED rather than reported with
    // a caveat: its base64 is a candidate for a production write, and half-verified bytes are
    // worse than none. Every check runs in the VM that produced the bytes.
    //
    // These replace the credit-note script's `only_field_changed`, which cannot survive a fix
    // whose fields are not known in advance. What moved is reported instead — see
    // `changed_fields` — and what is enforced here is that the term is still structurally the
    // thing the app will try to send.
    if (patchExpr) {
      const fail = firstAssertionFailure(result);
      if (fail) {
        rejects.push({ id: doc.id, reason: fail });
        continue;
      }
    }

    const newB64 = result.new_b64 || "";
    rows.push({
      ...doc,
      pretty: result.pretty,
      totalsBefore: renderTotals(result.totals_before),
      totalsAfter: renderTotals(result.totals_after),
      changedFields: (result.changed_fields || []).join(" "),
      modifiedPretty: result.modified_pretty || "",
      newB64,
      taskCommand: payloadTaskCommand(opts, doc.id, newB64),
      // The rollback is the ORIGINAL payload fed back through the same task. Emitted whenever
      // a write is emitted, because it is the thing you will want at the worst moment.
      rollbackCommand: newB64 ? payloadTaskCommand(opts, doc.id, doc.payloadBase64) : "",
      runbook: remediationRunbook(opts, doc, newB64),
      decodeSnippet: decodeSnippet(newB64 || doc.payloadBase64),
    });
  }

  // 3. Report.
  if (rows.length) {
    printIndex(rows);
    printLineItems(rows);
    printTerms(rows);
  }
  if (rejects.length) printRejects(rejects);
  printRunbooks(rows, opts);
  printSummary(rows, rejects);

  // The CSV is the deliverable, so it is written unless explicitly refused — there is no
  // prompt. `--no-csv` still has to mean something, though: a flag that is quietly ignored is
  // worse than one that doesn't exist. The originals are NOT subject to it; they are the
  // rollback, and losing them to a display flag would be indefensible.
  if (rows.length) {
    output.write(`\n  ${c.faint("originals:")} ${writeOriginals(rows)}\n`);
    if (opts.csv !== false) {
      output.write(`  ${c.faint("csv:")} ${writeCsv(opts.namespace, rows)}\n`);
      output.write(`  ${c.faint("sql:")} ${writeSql(opts.namespace)}\n`);
    } else {
      output.write(`  ${c.faint("csv: skipped (--no-csv)")}\n`);
    }
  }

  return rejects.length ? EXIT_DATA : 0;
}

// The assertions, in the order they are worth hearing about. First failure wins — a term that
// isn't a BillingDocument any more makes every later check meaningless noise.
function firstAssertionFailure(result) {
  if (!result.still_struct) {
    return "NOT A BILLINGDOCUMENT — the patch returned something else (nil, a bare map, another struct)";
  }
  if (!result.same_keys) {
    return "KEY SET CHANGED — the patch added or removed a field; use %{doc | …}, not a rebuild";
  }
  if (!result.round_trip_ok) {
    return "RE-ENCODE UNSOUND — the new base64 does not decode back to the patched term";
  }
  if (!result.lines_non_empty) {
    return "NO LINES LEFT — all_lines/1 is empty, and submission SILENTLY skips such a document";
  }
  if (!(result.changed_fields || []).length) {
    return "PATCH WAS A NO-OP — nothing changed, so there is nothing to write";
  }
  return null;
}

// --- entry point -------------------------------------------------------------

function usage() {
  console.log(`patch_invoice_payloads — decode, patch and remediate an invoice's payload_base64

Usage:
  ./patch_invoice_payloads.js [options]

Options:
  -m, --mode <mode>         ${MODES.join(" | ")} (default decode; implied by --patch-file)
  -n, --namespace <ns>      namespace the payloads are READ from (default ${DEFAULT_NAMESPACE})
      --ids <list>          accounting_documents.id values, comma or space separated
      --patch-file <path>   Elixir expression over doc/id, returning the patched document
      --any-type            allow document_type other than '${WANTED_DOCUMENT_TYPE}'
      --app-dir <path>      app-accounting-documents checkout that DECODES
                            (default ${DEFAULT_APP_DIR}; env ACCOUNTING_DOCUMENTS_DIR)
      --task-service <svc>  deployment named in the emitted Houston commands
                            (default accounting-documents-web on production)
      --no-csv              don't write the CSV (the originals are written regardless)
  -y, --yes                 approve the read without prompting
  -h, --help                this text

Anything not passed is prompted for. For a fully non-interactive run supply --ids and --yes.

  ./patch_invoice_payloads.js --ids 4687595,4762930 --yes
  ./patch_invoice_payloads.js --ids 4687595 --patch-file fix.exs --yes

payload_base64 is an Erlang term, so reading it needs a BEAM: the payloads are read from
production and decoded locally by 'mix run --no-start' in the app-accounting-documents
checkout, which loads the app's modules but starts nothing and never sees a
database.

THE PATCH FILE is an Elixir expression over two bound variables — \`doc\`, the decoded
%BillingDocument{}, and \`id\`, its accounting_documents.id as a string — returning the patched
document. One file can carry several documents' edits:

  case id do
    "4687595" -> %{doc | items: Enum.reject(doc.items, &(&1.line_item_id == 28408886))}
    "4762930" -> %{doc | previous_receipt_number: "INV/18142"}
  end

Use %{doc | …} rather than rebuilding the struct: it preserves untouched fields and raises on
a typo'd key. Match items on line_item_id, never on name or position.

Five assertions run in that same VM, and a document failing any of them is dropped rather than
reported with a caveat: still a BillingDocument, same key set, re-encode round-trips,
all_lines/1 non-empty, and the patch actually changed something. Which fields changed is
reported, not constrained. Never use byte length or md5 as a check — term_to_binary does not
preserve map key order, so both change even when nothing meaningful does.

Writes invoice-payloads-<namespace>-<date>.{csv,sql} and originals/<id>.b64. That last one is
the only rollback there is.

Read-only: SELECTs, a pure-function decode, and files. Every write is emitted for a human.

Exit codes: 0 all clean, 1 anything not decoded or not patched, 2 bad invocation or refused.`);
}

function parseArgs(argv) {
  const opts = {
    mode: null,
    namespace: DEFAULT_NAMESPACE,
    namespaceGiven: false,
    ids: null,
    patchFile: null,
    anyType: false,
    app: appDefaults(),
    csv: true,
    yes: false,
  };

  // A flag that needs a value must actually have one: `--ids` at the end of the line would
  // otherwise silently consume nothing and fall through to the prompt.
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
      case "-m":
      case "--mode": {
        const mode = value(arg, i++);
        if (!MODES.includes(mode)) {
          throw new UsageError(`Unknown mode: ${mode}. One of ${MODES.join(", ")}.`);
        }
        opts.mode = mode;
        break;
      }
      case "-n":
      case "--namespace":
        opts.namespace = value(arg, i++);
        opts.namespaceGiven = true;
        break;
      case "--ids":
        opts.ids = parseIds(value(arg, i++));
        break;
      case "--patch-file":
        opts.patchFile = value(arg, i++);
        break;
      case "--any-type":
        opts.anyType = true;
        break;
      case "--app-dir":
        opts.app.dir = value(arg, i++);
        break;
      case "--task-service":
        opts.taskService = value(arg, i++);
        break;
      case "--no-csv":
        opts.csv = false;
        break;
      case "-y":
      case "--yes":
        opts.yes = true;
        break;
      default:
        throw new UsageError(`Unknown argument: ${arg}`);
    }
  }

  // --patch-file is unambiguous about intent, so it selects the mode rather than being
  // ignored because --mode wasn't also passed. The contradiction is still an error.
  if (opts.patchFile && opts.mode === "decode") {
    throw new UsageError("--patch-file contradicts --mode decode. Drop one.");
  }
  if (opts.patchFile) opts.mode = "patch";

  return opts;
}

// Any mode not on READ_ONLY_MODES refuses without a terminal, in every namespace, and no flag
// overrides it. Both modes are read-only today; this exists so that whoever adds a write mode
// gets it gated by default.
function requireInteractive(mode) {
  if (input.isTTY) return;
  if (READ_ONLY_MODES.has(mode)) return;
  throw new UsageError(
    `Refusing to run "${mode}" without an interactive terminal. It is not a read-only mode.`
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.mode) opts.mode = input.isTTY ? await askMode() : "decode";
  requireInteractive(opts.mode);

  if (opts.mode === "patch" && !opts.patchFile) {
    throw new UsageError("--mode patch needs --patch-file. Run --help for the file's contract.");
  }
  const patchExpr = opts.patchFile ? readPatchFile(opts.patchFile) : null;

  if (!opts.namespaceGiven && input.isTTY) opts.namespace = await askNamespace();
  const env = psqlEnv(opts.namespace);

  // The ids have no default — there is nothing sensible to guess — so say so plainly rather
  // than let the prompt die on a closed stdin with a generic message.
  if (!opts.ids && !input.isTTY) {
    throw new UsageError("--ids is required when there is no terminal to prompt on.");
  }
  const ids = opts.ids || (await askDocumentIds());

  if (!(await confirmDataAccess(opts, env, resolveApp(opts.app), ids.length, patchExpr))) {
    output.write("\n  Cancelled. Nothing was read.\n");
    return EXIT_USAGE;
  }

  return run(opts, env, ids, patchExpr);
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
