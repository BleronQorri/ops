#!/usr/bin/env node
"use strict";

// force_retry_invoices — force-retry stuck e-invoices via Houston.
//
// Self-contained on purpose: one directory, one entrypoint, no shared library.
// Copy helpers from a sibling script rather than importing them.
//
// Given a list of e_invoice_tracker IDs, this:
//   1. Pulls those trackers from the accounting_documents DB (read-only psql)
//      to learn their accounting_document_id and current statuses.
//   2. Updates the trackers so they become eligible for retry, via the
//      `update_einvoice_trackers_status` Houston task:
//        upload_status -> failed_to_send   (always)
//        review_status -> picked            (you pick ONE value from
//                                            REVIEW_STATUSES; it is applied
//                                            uniformly to every pulled tracker,
//                                            regardless of each one's current
//                                            state — set `rejected` to make them
//                                            retry-eligible)
//   3. Force-retries sending of the underlying accounting documents via the
//      `retry_sending_failed_accounting_documents` Houston task.
//
// The retry action only ever enqueues docs whose tracker is
// `upload_status = failed_to_send` OR `review_status = rejected`, which is why
// step 2 runs first — it puts the trackers into that eligible state.
//
// On a terminal it asks for what the flags left out: the environment, whether to
// dry run, the tracker ids and the review_status. Each write is confirmed with a
// typed "yes", and in production a second time by typing "production".
//
// Usage:
//   ./force_retry_invoices.js
//   ./force_retry_invoices.js --env staging 123,456
//   ./force_retry_invoices.js --env production --dry-run false 123,456

const readline = require("readline/promises");
const { spawnSync } = require("child_process");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { header: sgr("1;37"), cmd: sgr("33"), faint: sgr("2"), bad: sgr("31"), warn: sgr("1;33") };

// --- constants -------------------------------------------------------------

const DB = "accounting_documents";

// Mirrors AccountingDocuments.Schemas.Enums
const REVIEW_STATUSES = [
  "not_started",
  "waiting_for_review",
  "approved",
  "rejected",
  "corrected",
  "failed",
];
const TARGET_UPLOAD_STATUS = "failed_to_send";

// Flipping upload_status to failed_to_send is what makes a tracker retry-eligible,
// which is the whole point — except when you are closing a document out rather than
// re-arming it. A document the provider parsed and refused (a malformed corrective,
// say) will fail identically forever, and `upload_status = failed_to_send` is one
// half of what the retry task selects on, so marking it that way quietly queues it
// for the next sweep. --review-only leaves upload_status as it is and writes the
// review status alone.

// --- arg parsing -----------------------------------------------------------

function usage() {
  return `force_retry_invoices — force-retry stuck e-invoices via Houston

Usage:
  force_retry_invoices [flags] [TRACKER_IDS]

On a terminal it asks for what is left out: the environment, whether to dry run,
the tracker ids and the review_status to set. Nothing else is needed to start.

Arguments:
  TRACKER_IDS            Comma-separated e_invoice_tracker IDs (e.g. 123,456)

Flags:
  -e, --env ENV          production or staging (prod / stg also work). Staging runs
                         against the eng-orion namespace unless --namespace says otherwise
      --dry-run BOOL     true (the default): pull the trackers and print the Houston
                         commands, run nothing. false: run them, each after a typed
                         confirmation — two in production. A bare --dry-run is true
      --review-status S  the review_status to set on every tracker, one of
                         ${REVIEW_STATUSES.join(", ")}
                         (asked for on a terminal when left out)
  -n, --namespace NAME   override the namespace (default: production, or eng-orion for
                         staging); the psql pull reads the same namespace
  -s, --service NAME     Houston service name (default: accounting-documents-web)
      --skip-update      Skip the tracker status update; only force-retry
      --skip-retry       Skip the force retry; only update tracker statuses
      --review-only      Write review_status alone, leave upload_status as it is, and
                         skip the retry (for closing a document out, not re-arming it)
  -h, --help             Show this help

Without a terminal nothing is asked: TRACKER_IDS and --env must be given, the run
is a dry run, and --dry-run false is refused.

Exit codes: 0 done, 1 a task failed or the operator stopped it, 2 the call was wrong.
`;
}

function fail(message, code) {
  process.stderr.write(`${c.bad("error:")} ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    env: null,
    dryRun: null,
    namespace: null,
    service: "accounting-documents-web",
    reviewStatus: null,
    skipUpdate: false,
    skipRetry: false,
    reviewOnly: false,
    ids: null,
  };
  const val = (flag, v) => {
    if (v === undefined || v.startsWith("-")) fail(`${flag} takes a value`, 2);
    return v;
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { process.stdout.write(usage()); process.exit(0); }
    else if (a === "-e" || a === "--env") opts.env = envOf(val(a, argv[++i]));
    else if (a === "--dry-run") {
      // A bare --dry-run means true; a value after it says which.
      const next = argv[i + 1];
      if (next === "true" || next === "false") opts.dryRun = argv[++i] === "true";
      else opts.dryRun = true;
    }
    else if (a.startsWith("--dry-run=")) opts.dryRun = boolOf(a.slice("--dry-run=".length));
    else if (a === "-n" || a === "--namespace") opts.namespace = val(a, argv[++i]);
    else if (a === "-s" || a === "--service") opts.service = val(a, argv[++i]);
    else if (a === "--review-status") opts.reviewStatus = reviewStatusOf(val(a, argv[++i]));
    else if (a === "--skip-update") opts.skipUpdate = true;
    else if (a === "--skip-retry") opts.skipRetry = true;
    else if (a === "--review-only") { opts.reviewOnly = true; opts.skipRetry = true; }
    else if (a.startsWith("-")) fail(`unknown flag: ${a}`, 2);
    else rest.push(a);
  }
  if (rest.length) opts.ids = rest.join(",");
  return opts;
}

function envOf(v) {
  const e = { production: "production", prod: "production", staging: "staging", stg: "staging" }[String(v).toLowerCase()];
  if (!e) fail(`--env takes production or staging, got ${JSON.stringify(v)}`, 2);
  return e;
}

function boolOf(v) {
  if (v !== "true" && v !== "false") fail(`--dry-run takes true or false, got ${JSON.stringify(v)}`, 2);
  return v === "true";
}

function reviewStatusOf(v) {
  const s = String(v).toLowerCase();
  if (!REVIEW_STATUSES.includes(s)) fail(`--review-status takes one of ${REVIEW_STATUSES.join(", ")}, got ${JSON.stringify(v)}`, 2);
  return s;
}

// --- asking ----------------------------------------------------------------

const TERMINAL = process.stdin.isTTY && process.stdout.isTTY;
// A picker hides the cursor while it draws; whatever ends the run, it comes back.
if (TERMINAL) process.on("exit", () => process.stdout.write("\x1b[?25h"));

const say = (s = "") => process.stdout.write(`  ${s}\n`);

// Stops the run: the operator said no, and nothing after it runs.
class Stop extends Error {}
function stop(message) {
  throw new Stop(message);
}

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
// tracker ids and the environment must be given, and the run is a dry run.
async function askMissing(o) {
  if (!TERMINAL) {
    if (!o.ids) fail("no tracker ids given — pass them comma-separated, e.g. 123,456", 2);
    if (!o.env) fail("no environment given — --env production or --env staging", 2);
    if (o.dryRun === false) fail("--dry-run false needs a terminal: every write is confirmed by hand", 2);
    o.dryRun = true;
  } else {
    if (!o.env) {
      o.env = await choose("Which environment?", [
        { value: "staging", label: "staging", note: o.namespace || "eng-orion" },
        { value: "production", label: "production" },
      ]);
    }
    if (o.dryRun === null) {
      o.dryRun = await choose("Dry run?", [
        { value: true, label: "true", note: "pull the trackers and print the Houston commands; write nothing" },
        { value: false, label: "false", note: "run the Houston tasks, each after a confirmation" },
      ]);
    }
  }
  if (!o.namespace) o.namespace = o.env === "production" ? "production" : "eng-orion";
  if (o.env === "staging" && o.namespace === "production") fail("--env staging cannot run against the production namespace", 2);
  if (o.env === "production" && o.namespace !== "production") fail(`--env production runs against the production namespace, not ${o.namespace}`, 2);
}

// One readline interface at a time, closed before a picker takes stdin and before
// houston runs, so nothing else is reading the terminal when houston asks its own
// questions.
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

function parseTrackerIds(raw) {
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = ids.filter((s) => !/^\d+$/.test(s));
  if (invalid.length) fail(`invalid tracker IDs (must be integers): ${invalid.join(", ")}`, 2);
  if (!ids.length) fail("no tracker IDs provided", 2);
  // dedupe, preserve as numbers-as-strings
  return [...new Set(ids)];
}

// The psql database environment for a given deploy namespace.
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

function runInherit(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(" ")}\n`);
  // No readline may hold stdin while houston runs: its own "Continue? (y/yes)"
  // prompt reads the terminal.
  closeRl();
  // Ensure the terminal is in cooked (line) mode so the child process's own
  // interactive prompts can read input.
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // not fatal — best effort
    }
  }
  const res = spawnSync(cmd, args, { stdio: "inherit" });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${cmd} exited with status ${res.status}`);
  }
}

// Fetch trackers by id. Returns [{id, accountingDocumentId, reviewStatus, uploadStatus}]
function fetchTrackers(env, ids) {
  const idList = ids.join(",");
  const sql =
    "SELECT id, accounting_document_id, review_status, upload_status " +
    `FROM e_invoice_trackers WHERE id IN (${idList});`;
  const out = runCapture("houston", [
    "psql",
    env,
    DB,
    "--",
    "-t", // tuples only
    "-A", // unaligned
    "-F",
    "|",
    "-c",
    sql,
  ]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, adId, review, upload] = line.split("|");
      return {
        id,
        accountingDocumentId: adId,
        reviewStatus: review || null,
        uploadStatus: upload || null,
      };
    });
}

// A write: only printed in a dry run; otherwise confirmed by a typed "yes", and in
// production a second time by typing "production". A wrong answer stops the run
// before this write (and so before any write after it). Houston still shows its
// own plan and "Continue?" prompt once it runs.
async function runOrPlan(label, args, opts) {
  if (opts.dryRun) {
    console.log(`\n[dry-run] houston ${args.join(" ")}`);
    return;
  }
  const where = opts.env === "production" ? c.bad("PRODUCTION") : c.warn(opts.namespace);
  console.log(`\n${c.warn("About to run")} ${label} in ${where}:`);
  console.log(`  ${c.cmd(`houston ${args.join(" ")}`)}`);
  const answer = (await ask(`  Type "yes" to run it: `)).toLowerCase();
  if (answer !== "yes") stop(`stopped before ${label} — it was not run`);
  if (opts.env === "production") {
    const again = await ask(`  This writes ${c.bad("PRODUCTION")}. Type "production" to confirm: `);
    if (again !== "production") stop(`stopped before ${label} — it was not run`);
  }
  runInherit("houston", args);
}

// One review_status applied to the whole list: the flag, or a picker on a
// terminal. Without either (a dry run with no terminal) the plan shows a
// placeholder where the value goes.
async function pickReviewStatus(opts) {
  if (opts.reviewStatus) return opts.reviewStatus;
  if (!TERMINAL) return null;
  console.log("");
  return choose("What review_status should be set for ALL of the trackers above?", REVIEW_STATUSES.map((s) => ({
    value: s,
    label: s,
    note: s === "rejected" ? "makes them retry-eligible" : undefined,
  })));
}

function fmtTable(rows) {
  return rows
    .map(
      (t) =>
        `  tracker=${t.id}  ad=${t.accountingDocumentId}  ` +
        `review=${t.reviewStatus ?? "∅"}  upload=${t.uploadStatus ?? "∅"}`
    )
    .join("\n");
}

// --- main ------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.skipUpdate && opts.skipRetry) fail("--skip-update and --skip-retry together leave nothing to do", 2);
  if (opts.ids) parseTrackerIds(opts.ids); // a malformed list is refused before anything is asked
  await askMissing(opts);

  const requestedIds = opts.ids
    ? parseTrackerIds(opts.ids)
    : parseTrackerIds(await ask("Comma-separated e_invoice_tracker IDs: "));

  const where = opts.env === "production" ? c.bad("production") : c.warn(`staging (${opts.namespace})`);
  console.log(
    `\nTarget: ${where} namespace=${opts.namespace} service=${opts.service}` +
      (opts.dryRun ? "  [DRY RUN]" : `  ${c.warn(`writes on confirmation${opts.env === "production" ? ", twice each" : ""}`)}`)
  );
  console.log(`Requested ${requestedIds.length} tracker ID(s): ${requestedIds.join(", ")}`);

  // 1. Pull -----------------------------------------------------------------
  console.log("\nPulling trackers from DB (read-only)…");
  const trackers = fetchTrackers(psqlEnv(opts.namespace), requestedIds);

  if (!trackers.length) {
    console.error("No trackers found for the given IDs. Nothing to do.");
    return;
  }
  const foundIds = new Set(trackers.map((t) => t.id));
  const missing = requestedIds.filter((id) => !foundIds.has(id));
  if (missing.length) {
    console.warn(`\n⚠ ${missing.length} tracker ID(s) not found and skipped: ${missing.join(", ")}`);
  }

  console.log(`\nFound ${trackers.length} tracker(s):`);
  console.log(fmtTable(trackers));

  // 2. Update tracker statuses ----------------------------------------------
  // upload_status is always failed_to_send; review_status is picked once and
  // applied uniformly to every pulled tracker.
  if (opts.skipUpdate) {
    console.log("\n(Skipping tracker status update — --skip-update)");
  } else {
    const reviewStatus = await pickReviewStatus(opts);
    const shownStatus = reviewStatus ?? "<review_status>";
    const trackerIds = trackers.map((t) => t.id);

    console.log("\n── Planned tracker updates ─────────────────────────────");
    console.log(
      `  review_status=${shownStatus}${opts.reviewOnly ? c.faint(", upload_status left as it is") : `, upload_status=${TARGET_UPLOAD_STATUS}`}  →  ` +
        `${trackerIds.length} tracker(s): ${trackerIds.join(", ")}`
    );
    if (opts.reviewOnly) console.log(c.faint("  (--review-only: not re-arming these for retry)"));
    if (!reviewStatus) console.log(c.faint("  (no terminal and no --review-status: the value is left as a placeholder)"));

    // Houston shows its own plan + "Continue? (y/yes)" prompt for this run.
    // Run the update task once for the whole list.
    const updateArgs = [
      "task",
      "run",
      opts.service,
      "--namespace",
      opts.namespace,
      "update_einvoice_trackers_status",
      "-p",
      `E_INVOICE_TRACKER_IDS=${trackerIds.join(",")}`,
      "-p",
      `REVIEW_STATUS=${shownStatus}`,
      // Omitted entirely under --review-only, so the task leaves it alone rather
      // than being handed the value it already has.
      ...(opts.reviewOnly ? [] : ["-p", `UPLOAD_STATUS=${TARGET_UPLOAD_STATUS}`]),
      "--no-tui",
      "-w",
    ];
    await runOrPlan("the tracker status update", updateArgs, opts);
  }

  // 3. Force retry ----------------------------------------------------------
  if (opts.skipRetry) {
    console.log("\n(Skipping force retry — --skip-retry)");
    if (opts.dryRun) console.log(`\n${c.faint("Dry run: nothing was written. --dry-run false runs the tasks, each after a confirmation.")}`);
    console.log("\n✓ Done.");
    return;
  }

  const adIds = [...new Set(trackers.map((t) => t.accountingDocumentId))];
  console.log("\n── Planned force retry ─────────────────────────────────");
  console.log(`  ${adIds.length} accounting document(s): ${adIds.join(", ")}`);
  console.log("  FORCE=true");
  console.log("  (Houston will show its own Continue? prompt before running.)");

  const retryArgs = [
    "task",
    "run",
    opts.service,
    "--namespace",
    opts.namespace,
    "retry_sending_failed_accounting_documents",
    "-p",
    `ACCOUNTING_DOCUMENT_IDS=${adIds.join(",")}`,
    "-p",
    "FORCE=true",
    "--no-tui",
    "-w",
  ];
  await runOrPlan("the FORCE retry", retryArgs, opts);

  if (opts.dryRun) console.log(`\n${c.faint("Dry run: nothing was written. --dry-run false runs the tasks, each after a confirmation.")}`);
  console.log("\n✓ Done.");
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
