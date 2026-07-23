#!/usr/bin/env node

// retry_invoices — re-drive stuck KSA e-invoices via Houston.
//
// Given a list of e_invoice_tracker IDs, this:
//   1. Pulls those trackers from the accounting_documents DB (read-only psql)
//      to learn their accounting_document_id and current statuses.
//   2. Updates the trackers so they become eligible for retry:
//        upload_status -> failed_to_send   (always)
//        review_status -> rejected         (only if already rejected;
//                                           otherwise you are prompted)
//      via the `update_einvoice_trackers_status` Houston task.
//   3. Force-retries sending of the underlying accounting documents via the
//      `retry_sending_failed_accounting_documents` Houston task.
//
// The retry action only ever enqueues docs whose tracker is
// `upload_status = failed_to_send` OR `review_status = rejected`, which is why
// step 2 runs first — it puts the trackers into that eligible state.
//
// Usage:
//   ./ri 123,456
//   ./ri --namespace eng-orion 123,456
//   ./ri --dry-run 123,456

const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const { spawnSync } = require("child_process");

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
const UPLOAD_STATUSES = [
  "not_started",
  "ready_to_send",
  "sending_in_progress",
  "sent",
  "failed_to_send",
  "rejected",
];

const TARGET_UPLOAD_STATUS = "failed_to_send";

// --- arg parsing -----------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    namespace: "production",
    service: "accounting-documents-web",
    dryRun: false,
    skipUpdate: false,
    skipRetry: false,
    ids: null,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--namespace" || a === "-n") opts.namespace = argv[++i];
    else if (a === "--service" || a === "-s") opts.service = argv[++i];
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--skip-update") opts.skipUpdate = true;
    else if (a === "--skip-retry") opts.skipRetry = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else rest.push(a);
  }
  if (rest.length) opts.ids = rest.join(",");
  return opts;
}

function usage() {
  console.log(`retry_invoices — re-drive stuck KSA e-invoices via Houston

Usage:
  ri [flags] <TRACKER_IDS>

Arguments:
  TRACKER_IDS            Comma-separated e_invoice_tracker IDs (e.g. 123,456)

Flags:
  -n, --namespace NAME   Kubernetes namespace / env (default: production)
  -s, --service NAME     Houston service name (default: accounting-documents-web)
      --dry-run          Pull + plan only; print Houston commands without running them
      --skip-update      Skip the tracker status update; only force-retry
      --skip-retry       Skip the force retry; only update tracker statuses
  -h, --help             Show this help

For --namespace production the psql pull uses "houston psql production ${DB}".
Other namespaces are treated as staging ("houston psql eng-orion ${DB}").`);
}

// --- helpers ---------------------------------------------------------------

function parseTrackerIds(raw) {
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = ids.filter((s) => !/^\d+$/.test(s));
  if (invalid.length) {
    throw new Error(`Invalid tracker IDs (must be integers): ${invalid.join(", ")}`);
  }
  if (!ids.length) throw new Error("No tracker IDs provided.");
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
  // Ensure the terminal is in cooked (line) mode so the child process's own
  // interactive prompts (e.g. Houston's "Continue? (y/yes)") can read input.
  if (input.isTTY) {
    try {
      input.setRawMode(false);
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

// Ask a single question with a fresh readline that is fully closed before we
// return — so no readline is holding stdin when we later spawn Houston (whose
// own prompt needs the terminal).
async function ask(question) {
  const rl = readline.createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

// Show the exact command and ask before running it. Returns true to proceed.
async function confirmRun(label, cmd, args) {
  console.log(`\nAbout to run ${label}:`);
  console.log(`  ${cmd} ${args.join(" ")}`);
  const ans = (await ask('Run this task? (type "yes" to proceed): ')).trim().toLowerCase();
  return ans === "yes" || ans === "y";
}

// Always prompt for a single review_status applied to the whole list.
async function promptReviewStatus() {
  console.log("\nWhat review_status should be set for ALL of the trackers above?");
  console.log(`  Options: ${REVIEW_STATUSES.join(", ")}`);
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = (await ask("  review_status> ")).trim().toLowerCase();
    if (REVIEW_STATUSES.includes(raw)) return raw;
    console.error(`  Invalid status "${raw}". Expected one of: ${REVIEW_STATUSES.join(", ")}`);
  }
  throw new Error("Too many invalid review_status attempts.");
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
  if (opts.help) return usage();
  if (opts.skipUpdate && opts.skipRetry) {
    console.error("--skip-update and --skip-retry together leave nothing to do.");
    process.exit(1);
  }

  const requestedIds = opts.ids
    ? parseTrackerIds(opts.ids)
    : parseTrackerIds(await ask("Comma-separated e_invoice_tracker IDs: "));

  console.log(
    `\nTarget: namespace=${opts.namespace} service=${opts.service}` +
      (opts.dryRun ? "  [DRY RUN]" : "")
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
  // upload_status is always failed_to_send; review_status is always prompted
  // and applied uniformly to every pulled tracker.
  if (opts.skipUpdate) {
    console.log("\n(Skipping tracker status update — --skip-update)");
  } else {
    const reviewStatus = await promptReviewStatus();
    const trackerIds = trackers.map((t) => t.id);

    console.log("\n── Planned tracker updates ─────────────────────────────");
    console.log(
      `  review_status=${reviewStatus}, upload_status=${TARGET_UPLOAD_STATUS}  →  ` +
        `${trackerIds.length} tracker(s): ${trackerIds.join(", ")}`
    );

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
      `REVIEW_STATUS=${reviewStatus}`,
      "-p",
      `UPLOAD_STATUS=${TARGET_UPLOAD_STATUS}`,
      "--no-tui",
      "-w",
    ];
    if (opts.dryRun) {
      console.log(`\n[dry-run] houston ${updateArgs.join(" ")}`);
    } else if (await confirmRun("the tracker status update", "houston", updateArgs)) {
      runInherit("houston", updateArgs);
    } else {
      console.log("Skipped the tracker status update.");
    }
  }

  // 3. Force retry ----------------------------------------------------------
  if (opts.skipRetry) {
    console.log("\n(Skipping force retry — --skip-retry)");
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
  if (opts.dryRun) {
    console.log(`\n[dry-run] houston ${retryArgs.join(" ")}`);
  } else if (await confirmRun("the FORCE retry", "houston", retryArgs)) {
    runInherit("houston", retryArgs);
  } else {
    console.log("Skipped the force retry.");
  }

  console.log("\n✓ Done.");
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
