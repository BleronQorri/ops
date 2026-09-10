#!/usr/bin/env node

// it_credential_lifecycle_bugbash — walk the IT Smart Receipts credential
// email ladder end to end against one plugin, and verify every step.
//
// The ladder is: 14 / 7 / 1 days before the credentials expire, then the pause,
// then 5 / 1 days of grace, then the disable. Waiting 90 real days is not an
// option, so each case moves the plugin's clock and triggers one pass.
//
// THE ONE RULE THIS SCRIPT EXISTS TO ENFORCE
//
//   `Verdict` never stores which email it sent. It re-derives it from
//   `last_email_sent_at` measured against the *current* deadline, and the
//   deadline comes from the anchor (`credentials_renewed_at + 90d`, or
//   `paused_sending_documents_at + 5d`). Move the anchor alone and the previous
//   email is re-read as the one under test, so the pass answers `:none` and
//   nothing sends. That is exactly what made the 2026-09-04 bug bash report
//   "the 14-day email arrived, the 7-day and 1-day never did".
//
//   Every case below therefore moves the anchor AND the stamp together, the
//   stamp landing where that case's previous email fell on the new timeline
//   (expiry −14d before the 7-day email, expiry −7d before the 1-day one).
//
// Verification is the database, not the mailbox. `Reminders.record/4` stamps
// `last_email_sent_at` and inserts `SendCredentialLifecycleEmailJob` in one
// transaction, so the presence or absence of that job row — with its `state`
// and `days` args — is the exact record of what the pass decided. The pass
// itself is a `DetectExpiringCredentialsWorker` row, which is how the script
// knows a pass actually ran before it judges a "no email" case.
//
// Usage:
//   ./it_credential_lifecycle_bugbash.js --plugin-id 541 --dry-run
//   ./it_credential_lifecycle_bugbash.js --provider-id 3086946 --enable
//   ./it_credential_lifecycle_bugbash.js --plugin-id 541 --cases 1-6
//   ./it_credential_lifecycle_bugbash.js --plugin-id 541 --reset

const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const { spawnSync } = require("child_process");
const fs = require("fs");

// --- constants -------------------------------------------------------------

const DB = "accounting_documents";
const STAMP_TASK = "update_smart_receipts_credentials_renewed_at";
const STATUS_TASK = "update_account_configuration_plugin_status";

// Mirrors AccountingDocuments.EInvoicing.Invopop.IT.SmartReceipts.CredentialLifecycle.
// Kept here only to compute dates; the pass is the thing under test, never these numbers.
const CREDENTIAL_LIFETIME_DAYS = 90;
const GRACE_PERIOD_DAYS = 5;

const PASS_WORKER = "DetectExpiringCredentialsWorker";
const EMAIL_WORKER = "SendCredentialLifecycleEmailJob";

// Datadog, through the pup CLI. Optional: a missing or unauthenticated pup
// downgrades the log checks to a warning rather than failing a case.
const LOG_SERVICE = "accounting-documents-worker";
const LOG_QUERY = '"IT Smart Receipts credential"';
const PASS_COMPLETE = "IT Smart Receipts credential lifecycle pass complete";
const REMINDER_RECORDED = "IT Smart Receipts credential reminder recorded";
const EMAIL_SENT = "Sent IT Smart Receipts credential email";
const EMAIL_FAILED = "Failed to send IT Smart Receipts credential email";
const ACTION_FAILED = "IT Smart Receipts credential lifecycle action failed";

// How long to wait for the pass the task schedules 10s out on the worker deployment.
const PASS_TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 5_000;

// --- the ladder ------------------------------------------------------------
//
// `stamp` is what `LAST_EMAIL_SENT_AT` gets:
//   "clear"        -> "null", nothing counts as sent
//   "keep"         -> variable omitted, the stamp stays where the last email left it
//   {expiryMinus}  -> the day that case's previous email fell on the new timeline
//   "pauseAnchor"  -> the pause day itself, where the 5-day grace email fell
//
// `expect` is the email the pass owes, or null for a case that must stay silent.

const CASES = [
  {
    id: 1,
    key: "before-window",
    phase: "expiry",
    name: "anchor outside the 14-day window",
    daysLeft: 20,
    stamp: "clear",
    expect: null,
  },
  {
    id: 2,
    key: "expiry-14",
    phase: "expiry",
    name: "14-day email",
    daysLeft: 14,
    stamp: "clear",
    expect: { state: "expiring", days: 14 },
  },
  {
    id: 3,
    key: "expiry-no-repeat",
    phase: "expiry",
    name: "a day later, no repeat (covers any day 13-8)",
    daysLeft: 13,
    stamp: "keep",
    expect: null,
  },
  {
    id: 4,
    key: "expiry-7",
    phase: "expiry",
    name: "7-day email",
    daysLeft: 7,
    stamp: { expiryMinus: 14 },
    expect: { state: "expiring", days: 7 },
  },
  {
    id: 5,
    key: "expiry-no-repeat-late",
    phase: "expiry",
    name: "no repeat after the 7-day email (covers 6-2)",
    daysLeft: 5,
    stamp: "keep",
    expect: null,
  },
  {
    id: 6,
    key: "expiry-1",
    phase: "expiry",
    name: "1-day email",
    daysLeft: 1,
    stamp: { expiryMinus: 7 },
    expect: { state: "expiring", days: 1 },
  },
  {
    id: 7,
    key: "pause",
    phase: "expiry",
    name: "pause on the expiry date, opening the grace period",
    daysLeft: 0,
    stamp: "keep",
    expect: { state: "paused", days: GRACE_PERIOD_DAYS },
    pauses: true,
  },
  {
    id: 8,
    key: "grace-no-repeat",
    phase: "grace",
    name: "no repeat of the grace email",
    graceLeft: 3,
    stamp: "pauseAnchor",
    expect: null,
  },
  {
    id: 9,
    key: "grace-1",
    phase: "grace",
    name: "1-day grace email",
    graceLeft: 1,
    stamp: "pauseAnchor",
    expect: { state: "paused", days: 1 },
  },
  {
    id: 10,
    key: "disable",
    phase: "grace",
    name: "disable at the end of the grace period",
    graceLeft: 0,
    stamp: "keep",
    expect: { state: "disabled", days: GRACE_PERIOD_DAYS },
    disables: true,
  },
];

// --- arg parsing -----------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    env: "production",
    service: "accounting-documents-web",
    pluginId: null,
    providerId: null,
    cases: null,
    dryRun: false,
    yes: false,
    enable: false,
    reset: false,
    report: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--env" || a === "-e") opts.env = argv[++i];
    else if (a === "--service" || a === "-s") opts.service = argv[++i];
    else if (a === "--plugin-id" || a === "-p") opts.pluginId = argv[++i];
    else if (a === "--provider-id") opts.providerId = argv[++i];
    else if (a === "--cases" || a === "-c") opts.cases = argv[++i];
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--yes") opts.yes = true;
    else if (a === "--enable") opts.enable = true;
    else if (a === "--reset") opts.reset = true;
    else if (a === "--no-report") opts.report = false;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

function usage() {
  console.log(`it_credential_lifecycle_bugbash — walk the IT Smart Receipts credential email ladder

Usage:
  ./it_credential_lifecycle_bugbash.js            fully interactive, asks for everything
  ./it_credential_lifecycle_bugbash.js --plugin-id 541 --cases 1-6

Fully interactive: it prompts for the environment and the target, shows the
state and the blast radius, and then asks before every single step. Any answer
other than yes stops the run. The flags below only pre-fill the prompts.

Target (prompted if absent):
  -p, --plugin-id ID     account_configuration_plugins.id
      --provider-id ID   resolve the plugin from the provider instead

Flags:
  -e, --env NAME         Houston env (default: production)
  -s, --service NAME     Houston service (default: accounting-documents-web)
  -c, --cases LIST       Which cases to run, by number or name:
                         "4", "1,2,4", "1-6", "expiry-7", "pause,disable" (default: all)
      --enable           Offer the enable step up front (a fresh onboarding sits
                         at pending, which the pass ignores)
      --reset            Offer the reset step (anchor = now, both stamps cleared)
                         and exit
      --dry-run          Print the computed dates and the exact Houston commands
                         for every selected case; touch nothing, ask nothing
      --yes              Lift the TTY requirement. Allowed with --dry-run only
      --no-report        Do not write the dated markdown report
  -h, --help             Show this help

Cases:
${CASES.map((c) => `  ${String(c.id).padStart(2)}  ${c.key.padEnd(22)} ${c.phase.padEnd(6)}  ${c.name}`).join("\n")}

Every case is one Houston run that writes the stamps and schedules the pass
(RUN_LIFECYCLE=true), followed by a wait for the pass to complete and a read of
the Oban job it did or did not insert. Between cases it stops and asks again, so
you can check the mailbox and the front end before moving on. Case 10 is
one-way: it deregisters the supplier at Invopop, marks every held document
rejected/failed, and blocks a credential re-submission on that plugin.

Blast radius: the pass settles EVERY enabled or paused Smart Receipts plugin
whose provider has ORION_COMMERCIAL_DOCUMENTS_IT_CREDENTIAL_LIFECYCLE on, not
just the target. The pre-flight prints the roster so you can see who else moves.`);
}

// --- shell helpers ---------------------------------------------------------

function runCapture(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
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
  // Houston prompts for confirmation on production, so the child needs the
  // terminal in cooked mode and our stdio.
  if (input.isTTY) {
    try {
      input.setRawMode(false);
    } catch {
      // best effort
    }
  }
  const res = spawnSync(cmd, args, { stdio: "inherit" });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${cmd} exited with status ${res.status}`);
}

function psql(env, sql) {
  return runCapture("houston", ["psql", env, DB, "--", "-t", "-A", "-F", "|", "-c", sql]);
}

function rows(out) {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith("(") && !l.includes("INFO houston:"))
    .map((l) => l.split("|"));
}

async function ask(question) {
  const rl = readline.createInterface({ input, output });
  try {
    return await rl.question(question);
  } catch {
    // Ctrl+D or a closed stdin. Treated as "stop" rather than as an answer.
    throw new Error("no answer on stdin — stopping.");
  } finally {
    rl.close();
  }
}

async function confirm(question) {
  const ans = (await ask(`${question} [yes/no] `)).trim().toLowerCase();
  return ans === "yes" || ans === "y";
}

// Every step goes through here, so one "no" ends the run rather than silently
// carrying on with a half-applied ladder.
async function gate(question) {
  if (await confirm(`  ${question}`)) return true;
  console.log("  stopped here.");
  return false;
}

async function askDefault(question, fallback) {
  const ans = (await ask(`${question} [${fallback}] `)).trim();
  return ans === "" ? fallback : ans;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- dates -----------------------------------------------------------------
//
// Calendar days in UTC, matching `Date.diff/2` on `DateTime.to_date/1` in
// `Verdict.days_between/2`. The time of day is irrelevant to the pass, so every
// stamp this script writes is midnight.

function today() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function addDays(date, days) {
  const out = new Date(date.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

const isoDate = (date) => date.toISOString().slice(0, 10);
const isoStamp = (date) => `${isoDate(date)}T00:00:00Z`;

// The dates one case needs, derived from the day it runs.
function plan(kase, base = today()) {
  if (kase.phase === "expiry") {
    const expiry = addDays(base, kase.daysLeft);
    const anchor = addDays(expiry, -CREDENTIAL_LIFETIME_DAYS);
    const stamp =
      kase.stamp === "clear"
        ? "null"
        : kase.stamp === "keep"
          ? null
          : isoStamp(addDays(expiry, -kase.stamp.expiryMinus));
    return {
      params: {
        CREDENTIALS_RENEWED_AT: isoStamp(anchor),
        ...(stamp ? { LAST_EMAIL_SENT_AT: stamp } : {}),
      },
      summary: `anchor ${isoDate(anchor)} -> expiry ${isoDate(expiry)}, ${kase.daysLeft} days left`,
    };
  }

  const pauseAnchor = addDays(base, -(GRACE_PERIOD_DAYS - kase.graceLeft));
  const disableOn = addDays(pauseAnchor, GRACE_PERIOD_DAYS);
  const stamp = kase.stamp === "pauseAnchor" ? isoStamp(pauseAnchor) : null;
  return {
    params: {
      // A value here reads as a credential renewal and the grace period stops
      // evaluating, so the anchor must stay closed for every grace case.
      CREDENTIALS_RENEWED_AT: "null",
      PAUSED_SENDING_DOCUMENTS_AT: isoStamp(pauseAnchor),
      ...(stamp ? { LAST_EMAIL_SENT_AT: stamp } : {}),
    },
    summary: `paused ${isoDate(pauseAnchor)} -> disable ${isoDate(disableOn)}, ${kase.graceLeft} days of grace left`,
  };
}

// --- reads -----------------------------------------------------------------

function resolvePluginId(env, providerId) {
  const found = rows(
    psql(
      env,
      `SELECT p.id FROM account_configuration_plugins p
        WHERE p.provider_id = ${providerId}
          AND p.integrator = 'invopop' AND p.integration = 'smart_receipts';`
    )
  );
  if (found.length !== 1) {
    throw new Error(
      `Expected exactly one Smart Receipts plugin for provider ${providerId}, found ${found.length}. Pass --plugin-id.`
    );
  }
  return found[0][0];
}

function readState(env, pluginId) {
  const out = rows(
    psql(
      env,
      `SELECT p.id, p.provider_id, p.account_configuration_id, p.integrator, p.integration,
              p.plugin_status, p.third_party_integration_status,
              COALESCE(c.credentials_renewed_at::text, ''),
              COALESCE(c.last_email_sent_at::text, ''),
              COALESCE(p.paused_sending_documents_at::text, ''),
              COALESCE((c.credentials_renewed_at + interval '${CREDENTIAL_LIFETIME_DAYS} days')::date::text, ''),
              COALESCE(((c.credentials_renewed_at + interval '${CREDENTIAL_LIFETIME_DAYS} days')::date - current_date)::text, ''),
              COALESCE(((p.paused_sending_documents_at + interval '${GRACE_PERIOD_DAYS} days')::date - current_date)::text, '')
         FROM account_configuration_plugins p
         JOIN e_invoice_it_smart_receipts_configuration c ON c.plugin_id = p.id
        WHERE p.id = ${pluginId};`
    )
  );
  if (!out.length) {
    throw new Error(
      `Plugin ${pluginId} has no e_invoice_it_smart_receipts_configuration row — not an IT Smart Receipts plugin.`
    );
  }
  const [
    id,
    providerId,
    accountConfigurationId,
    integrator,
    integration,
    pluginStatus,
    thirdPartyStatus,
    renewedAt,
    lastEmailSentAt,
    pausedAt,
    expiresOn,
    daysLeft,
    graceLeft,
  ] = out[0];
  return {
    id,
    providerId,
    accountConfigurationId,
    integrator,
    integration,
    pluginStatus,
    thirdPartyStatus,
    renewedAt,
    lastEmailSentAt,
    pausedAt,
    expiresOn,
    daysLeft,
    graceLeft,
  };
}

function maxObanId(env) {
  return Number(rows(psql(env, "SELECT COALESCE(MAX(id), 0) FROM oban_jobs;"))[0][0]);
}

function passJobsSince(env, sinceId) {
  return rows(
    psql(
      env,
      `SELECT id, state FROM oban_jobs
        WHERE worker LIKE '%${PASS_WORKER}' AND id > ${sinceId} ORDER BY id;`
    )
  ).map(([id, state]) => ({ id: Number(id), state }));
}

function emailJobsSince(env, sinceId, providerId) {
  return rows(
    psql(
      env,
      `SELECT id, state, args->>'state', args->>'days' FROM oban_jobs
        WHERE worker LIKE '%${EMAIL_WORKER}' AND id > ${sinceId}
          AND args->>'provider_id' = '${providerId}' ORDER BY id;`
    )
  ).map(([id, jobState, state, days]) => ({
    id: Number(id),
    jobState,
    state,
    days: Number(days),
  }));
}

// The database's own clock, so a window is never widened or narrowed by skew
// between this laptop and the server.
function dbNowUtc(env) {
  return rows(psql(env, "SELECT (now() AT TIME ZONE 'utc')::text;"))[0][0];
}

function obanJob(env, id) {
  const found = rows(psql(env, `SELECT state FROM oban_jobs WHERE id = ${id};`));
  return found.length ? found[0][0] : "deleted";
}

// The email command the job emits: one `outbox_events` row on
// `email-generator.commands-v1`, published from there by Debezium.
//
// `timestamp` is the only index on that table and it is `timestamp without time
// zone` holding UTC, so the window leads and `topic_name` is a post-filter —
// about 1.3k rows land in a 20-minute window on this service, which the planner
// walks cheaply (index scan backward, ~74ms in production). There is no provider
// column: the payload is protobuf `bytea`, and `partition_key` is
// `upper(md5(recipient))`, which this script cannot compute because the
// recipient is resolved inside the job by RPC. So the count is corroboration,
// not attribution.
function outboxEmailCommandsSince(env, sinceUtc) {
  return rows(
    psql(
      env,
      `SELECT timestamp::text, partition_key, length(proto_payload)
         FROM outbox_events
        WHERE timestamp > '${sinceUtc}'::timestamp
          AND topic_name = 'email-generator.commands-v1'
        ORDER BY timestamp DESC;`
    )
  ).map(([at, partitionKey, bytes]) => ({ at, partitionKey, bytes: Number(bytes) }));
}

// The worker's own account of the pass: the outcome counts, what it decided for
// one provider, and whether the email job actually got the command out.
// `null` means pup could not answer, which is reported but never fails a case.
function logEvidence(env, minutes) {
  const args = [
    "logs",
    "search",
    "--from",
    `${minutes}m`,
    "--limit",
    "50",
    "--no-agent",
    "--query",
    `env:${env} service:${LOG_SERVICE} ${LOG_QUERY}`,
  ];
  const res = spawnSync("pup", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (res.error || res.status !== 0) return null;

  // pup prefixes chatter such as "Access token refreshed automatically".
  const start = res.stdout.indexOf("{");
  if (start < 0) return null;
  try {
    return (JSON.parse(res.stdout.slice(start)).data ?? []).map((entry) => ({
      message: entry.attributes?.message ?? "",
      at: entry.attributes?.attributes?.timestamp ?? "",
      payload: entry.attributes?.attributes?.payload ?? {},
    }));
  } catch {
    return null;
  }
}

function heldDocuments(env, accountConfigurationId) {
  return rows(
    psql(
      env,
      `SELECT t.upload_status, t.review_status, COUNT(*)
         FROM accounting_documents ad
         JOIN e_invoice_trackers t ON t.id = ad.latest_tracker_id
        WHERE ad.account_configuration_id = ${accountConfigurationId}
        GROUP BY 1, 2 ORDER BY 3 DESC;`
    )
  ).map(([upload, review, count]) => ({ upload, review, count: Number(count) }));
}

// Every plugin the pass will settle alongside the target, flag permitting.
function inScopePlugins(env) {
  return rows(
    psql(
      env,
      `SELECT p.id, p.provider_id, p.plugin_status,
              COALESCE(((c.credentials_renewed_at + interval '${CREDENTIAL_LIFETIME_DAYS} days')::date - current_date)::text, '-'),
              COALESCE(((p.paused_sending_documents_at + interval '${GRACE_PERIOD_DAYS} days')::date - current_date)::text, '-')
         FROM account_configuration_plugins p
         JOIN e_invoice_it_smart_receipts_configuration c ON c.plugin_id = p.id
        WHERE p.integrator = 'invopop' AND p.integration = 'smart_receipts'
          AND p.plugin_status IN ('enabled', 'paused')
        ORDER BY p.id;`
    )
  ).map(([id, providerId, status, daysLeft, graceLeft]) => ({
    id,
    providerId,
    status,
    daysLeft,
    graceLeft,
  }));
}

// --- writes ----------------------------------------------------------------

function stampArgs(opts, pluginId, params, runLifecycle) {
  const args = ["task", "run", opts.service];
  if (opts.env !== "production") args.push("--namespace", opts.env);
  args.push(STAMP_TASK, "-p", `ACCOUNT_CONFIGURATION_PLUGIN_ID=${pluginId}`);
  for (const [key, value] of Object.entries(params)) args.push("-p", `${key}=${value}`);
  args.push("-p", "DRY_RUN=false");
  if (runLifecycle) {
    args.push("-p", "RUN_LIFECYCLE=true", "-p", "OBAN_STORER_ENABLED=1");
  } else {
    args.push("-p", "RUN_LIFECYCLE=false");
  }
  // `-w` is not the default: without it Houston returns once the Job is created,
  // and every read below would race the write. `--no-tui` keeps the output plain
  // so a failure is legible in a transcript.
  return [...args, "-w", "--no-tui"];
}

function statusArgs(opts, accountConfigurationId) {
  const args = ["task", "run", opts.service];
  if (opts.env !== "production") args.push("--namespace", opts.env);
  args.push(
    STATUS_TASK,
    "-p",
    `ACCOUNT_CONFIGURATION_ID=${accountConfigurationId}`,
    "-p",
    "PLUGIN_STATUS=enabled",
    "-p",
    "THIRD_PARTY_INTEGRATION_STATUS=enabled"
  );
  return [...args, "-w", "--no-tui"];
}

// The task inserts the pass 10 seconds out and exits; the pass itself runs in
// the worker deployment. Waiting for its Oban row to leave `available` is what
// makes a "no email" verdict mean something.
async function waitForPass(env, sinceId) {
  const deadline = Date.now() + PASS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const jobs = passJobsSince(env, sinceId);
    const settled = jobs.find((j) => ["completed", "discarded", "cancelled"].includes(j.state));
    if (settled) return settled;
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

// The email job runs on the worker within a second or two of the pass, but a
// discarded one is only visible once it has settled.
async function waitForEmailJob(env, id) {
  const deadline = Date.now() + 60_000;
  let state = obanJob(env, id);
  while (Date.now() < deadline && ["available", "scheduled", "executing", "retryable"].includes(state)) {
    await sleep(POLL_INTERVAL_MS);
    state = obanJob(env, id);
  }
  // Oban prunes finished jobs, so a row that has vanished between two reads had
  // finished. Which way it finished is then a question for the logs, not here.
  return state;
}

// --- case execution --------------------------------------------------------

function describeCase(kase, computed) {
  const stamp = computed.params.LAST_EMAIL_SENT_AT ?? "(unchanged)";
  const wants = kase.expect ? `email ${kase.expect.state}/${kase.expect.days}` : "no email";
  return `case ${kase.id} ${kase.key} — ${kase.name}\n    ${computed.summary}\n    stamp ${stamp}, expect ${wants}`;
}

async function runCase(kase, opts, state, results) {
  const computed = plan(kase);
  console.log(`\n${"-".repeat(78)}\n${describeCase(kase, computed)}`);

  const args = stampArgs(opts, state.id, computed.params, true);

  if (opts.dryRun) {
    console.log(`\n  houston ${args.join(" ")}`);
    results.push({ ...kase, computed, outcome: "planned" });
    return true;
  }

  console.log(`\n  houston ${args.join(" ")}`);

  if (kase.disables) {
    const docs = heldDocuments(opts.env, state.accountConfigurationId);
    const held = docs
      .filter((d) => d.upload === "not_started")
      .reduce((sum, d) => sum + d.count, 0);
    console.log(
      `\n  This case is one-way. It deregisters the supplier at Invopop, marks ${held} held\n` +
        `  document(s) rejected/failed, and blocks credential re-submission on plugin ${state.id}.`
    );
    if (!(await gate("Disable this integration for good?"))) {
      results.push({ ...kase, computed, outcome: "skipped" });
      return false;
    }
  } else if (!(await gate("Write these stamps and run the pass?"))) {
    results.push({ ...kase, computed, outcome: "skipped" });
    return false;
  }

  const since = maxObanId(opts.env);
  const sinceUtc = dbNowUtc(opts.env);
  // Log lines are matched against this, with 30 seconds of slack for clock skew
  // between here and Datadog. Without it the previous case's reminder line would
  // still be inside the query window and would fail the next "no email" case.
  const startedAt = new Date(Date.now() - 30_000).toISOString();

  try {
    // Returns once the task pod has finished, so the stamps are on disk before
    // anything below reads them.
    runInherit("houston", args);
  } catch (err) {
    console.log(`  FAIL\n    - the task itself failed: ${err.message}`);
    results.push({ ...kase, computed, outcome: "fail", detail: `task failed: ${err.message}` });
    return false;
  }

  console.log("  task finished. waiting for the pass to run on the worker...");
  const pass = await waitForPass(opts.env, since);
  if (!pass) {
    results.push({
      ...kase,
      computed,
      outcome: "fail",
      detail: `no ${PASS_WORKER} job settled within ${PASS_TIMEOUT_MS / 1000}s`,
    });
    return false;
  }
  console.log(`  pass job ${pass.id} ${pass.state}`);

  const emails = emailJobsSince(opts.env, since, state.providerId);
  const after = readState(opts.env, state.id);
  const problems = [];

  if (kase.expect) {
    if (emails.length !== 1) {
      problems.push(
        `expected 1 email job, found ${emails.length}${
          emails.length ? ` (${emails.map((e) => `${e.state}/${e.days}`).join(", ")})` : ""
        }`
      );
    } else {
      const [email] = emails;
      if (email.state !== kase.expect.state || email.days !== kase.expect.days) {
        problems.push(
          `expected ${kase.expect.state}/${kase.expect.days}, got ${email.state}/${email.days}`
        );
      }

      const jobState = await waitForEmailJob(opts.env, email.id);
      console.log(`  email job ${email.id} ${jobState} (${email.state}/${email.days})`);
      if (!["completed", "deleted"].includes(jobState)) {
        problems.push(`email job ${email.id} is ${jobState}, expected completed`);
      } else {
        // A job that ran has inserted its command, so an empty outbox here means
        // the send never left this service.
        const commands = outboxEmailCommandsSince(opts.env, sinceUtc);
        if (!commands.length) {
          problems.push("email job finished but no email-generator command in the outbox");
        } else {
          console.log(
            `  outbox: ${commands.length} email-generator command(s) since ${sinceUtc}` +
              ` (newest ${commands[0].at}, key ${commands[0].partitionKey}, ${commands[0].bytes} bytes)`
          );
        }
      }
    }
    if (!after.lastEmailSentAt.startsWith(isoDate(today()))) {
      problems.push(`last_email_sent_at did not move to today (${after.lastEmailSentAt || "null"})`);
    }
  } else if (emails.length) {
    problems.push(
      `expected no email, got ${emails.map((e) => `${e.state}/${e.days}`).join(", ")}`
    );
  }

  // What the worker itself says it did. Advisory when pup cannot answer.
  const allLogs = logEvidence(opts.env, 15);
  const logs = allLogs && allLogs.filter((l) => l.at >= startedAt);
  if (!logs) {
    console.log("  logs: pup unavailable — skipped (run `pup auth login` for this check)");
  } else {
    const mine = (line) => String(line.payload.provider_id ?? "") === String(state.providerId);
    const pass = logs.find((l) => l.message === PASS_COMPLETE);
    const reminders = logs.filter((l) => l.message === REMINDER_RECORDED && mine(l));
    const sent = logs.filter((l) => l.message === EMAIL_SENT && mine(l));
    const failures = logs.filter(
      (l) => [EMAIL_FAILED, ACTION_FAILED].includes(l.message) && (mine(l) || !l.payload.provider_id)
    );

    if (pass) {
      const c = pass.payload;
      console.log(
        `  logs: pass reminded=${c.reminded_count} skipped=${c.skipped_count} paused=${c.paused_count} ` +
          `disabled=${c.disabled_count} flag_off=${c.flag_off_count} failed=${c.failed_count}`
      );
      if (c.failed_count > 0) problems.push(`pass reported failed_count=${c.failed_count}`);
    } else {
      console.log(`  logs: no "${PASS_COMPLETE}" line in the last 15 minutes`);
    }

    for (const line of failures) {
      problems.push(`log: ${line.message} — ${JSON.stringify(line.payload.error ?? line.payload)}`);
    }

    if (kase.expect) {
      const reminder = reminders.find(
        (l) => l.payload.state === kase.expect.state && l.payload.reminder_days === kase.expect.days
      );
      if (reminder) console.log(`  logs: reminder recorded ${reminder.payload.state}/${reminder.payload.reminder_days}`);
      else problems.push(`log: no reminder recorded for ${kase.expect.state}/${kase.expect.days}`);

      const send = sent.find((l) => l.payload.state === kase.expect.state);
      if (send) console.log(`  logs: email sent (${send.payload.state}) at ${send.at}`);
      else problems.push(`log: no "${EMAIL_SENT}" line for state ${kase.expect.state}`);
    } else if (reminders.length) {
      problems.push(
        `log: reminder recorded when none was owed (${reminders
          .map((l) => `${l.payload.state}/${l.payload.reminder_days}`)
          .join(", ")})`
      );
    }
  }

  if (kase.pauses) {
    if (after.pluginStatus !== "paused") problems.push(`plugin_status is ${after.pluginStatus}`);
    if (after.thirdPartyStatus !== "disabled") {
      problems.push(`third_party_integration_status is ${after.thirdPartyStatus}`);
    }
    if (after.renewedAt) problems.push(`credentials_renewed_at not cleared (${after.renewedAt})`);
    if (!after.pausedAt.startsWith(isoDate(today()))) {
      problems.push(`paused_sending_documents_at is ${after.pausedAt || "null"}`);
    }
  }

  if (kase.disables) {
    // Revoke parks the plugin at `:pending` until the SUPPLIER_DEREGISTRATION_*
    // webhook lands and makes it `:disabled` / `:revoked`.
    if (!["pending", "disabled"].includes(after.pluginStatus)) {
      problems.push(`plugin_status is ${after.pluginStatus}, expected pending or disabled`);
    }
    const docs = heldDocuments(opts.env, state.accountConfigurationId);
    const stillHeld = docs
      .filter((d) => d.upload === "not_started")
      .reduce((sum, d) => sum + d.count, 0);
    if (stillHeld) problems.push(`${stillHeld} document(s) still not_started`);
    console.log(
      `  documents: ${docs.map((d) => `${d.count}x ${d.upload}/${d.review}`).join(", ") || "none"}`
    );
  }

  console.log(
    `  state: ${after.pluginStatus}/${after.thirdPartyStatus}` +
      ` renewed_at=${after.renewedAt || "null"}` +
      ` last_email=${after.lastEmailSentAt || "null"}` +
      ` paused_at=${after.pausedAt || "null"}` +
      (after.daysLeft ? ` (${after.daysLeft}d to expiry)` : "") +
      (after.graceLeft ? ` (${after.graceLeft}d of grace)` : "")
  );

  const outcome = problems.length ? "fail" : "pass";
  console.log(
    outcome === "pass"
      ? "  PASS"
      : `  FAIL\n${problems.map((p) => `    - ${p}`).join("\n")}`
  );
  results.push({ ...kase, computed, outcome, detail: problems.join("; ") });
  return outcome === "pass";
}

// --- report ----------------------------------------------------------------

function writeReport(env, state, results) {
  const stamp = new Date().toISOString().slice(0, 10);
  const path = `it-credential-lifecycle-bugbash-${env}-${stamp}.md`;
  const mark = (outcome) =>
    ({ pass: "✅", fail: "❌", skipped: "—", planned: "·" })[outcome] ?? outcome;

  const lines = [
    `# IT Smart Receipts credential email ladder — ${env}, ${stamp}`,
    "",
    `| provider id | account configuration id | plugin id |`,
    `| --- | --- | --- |`,
    `| ${state.providerId} | ${state.accountConfigurationId} | ${state.id} |`,
    "",
    "| # | name | phase | case | clock | expect | result | detail |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...results.map(
      (r) =>
        `| ${r.id} | \`${r.key}\` | ${r.phase} | ${r.name} | ${r.computed.summary} | ${
          r.expect ? `email \`${r.expect.state}/${r.expect.days}\`` : "no email"
        } | ${mark(r.outcome)} | ${r.detail || ""} |`
    ),
    "",
    "Verification is the `SendCredentialLifecycleEmailJob` Oban row, inserted in the same",
    "transaction as the `last_email_sent_at` stamp, after the `DetectExpiringCredentialsWorker`",
    "pass has completed. Each case moves the anchor and the stamp together — moving the anchor",
    "alone makes the previous email re-derive as the one under test and nothing sends.",
    "",
  ];
  fs.writeFileSync(path, lines.join("\n"));
  return path;
}

// --- main ------------------------------------------------------------------

// Accepts numbers, ranges and names: "4", "1-6", "expiry-7", "pause,disable".
function selectCases(spec) {
  if (!spec) return CASES;
  const wanted = new Set();
  for (const part of spec.split(",").map((s) => s.trim())) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      for (let i = Number(range[1]); i <= Number(range[2]); i++) wanted.add(i);
    } else if (/^\d+$/.test(part)) {
      wanted.add(Number(part));
    } else {
      const named = CASES.find((c) => c.key === part.toLowerCase());
      if (!named) throw new Error(`Bad --cases value: ${part}`);
      wanted.add(named.id);
    }
  }
  const picked = CASES.filter((c) => wanted.has(c.id));
  if (!picked.length) throw new Error(`No cases matched --cases ${spec}`);
  return picked;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();

  // Everything here writes production data, so a terminal is required. --yes
  // lifts that for --dry-run only, which touches nothing and asks nothing.
  const planOnly = opts.dryRun;
  if (!input.isTTY && !(planOnly && opts.yes)) {
    throw new Error("Refusing to run without a TTY. Use --dry-run --yes for a plan.");
  }

  // Validated before anything touches the database, so a typo fails on its own
  // terms rather than as a psql error.
  let selected = selectCases(opts.cases);

  console.log(
    "\nit_credential_lifecycle_bugbash — the IT Smart Receipts credential email ladder\n" +
      "  14 / 7 / 1 days to expiry, the pause, 5 / 1 days of grace, the disable.\n" +
      "  Each case moves the anchor AND the stamp together: moving the anchor alone makes\n" +
      "  the last email re-derive as the one under test, and nothing sends.\n" +
      (planOnly ? "  --dry-run: nothing is written and nothing is asked.\n" : "")
  );

  const env = planOnly ? opts.env : await askDefault("Environment?", opts.env);

  if (!planOnly && !(await gate(`Read plugin state from ${env}?`))) return;

  let pluginId = opts.pluginId;
  if (!pluginId && !opts.providerId) {
    const answer = await ask("  Plugin id, or \"provider <id>\": ");
    const asProvider = answer.trim().match(/^provider\s+(\d+)$/i);
    if (asProvider) pluginId = resolvePluginId(env, asProvider[1]);
    else if (/^\d+$/.test(answer.trim())) pluginId = answer.trim();
    else throw new Error(`Cannot read a target from: ${answer.trim() || "(empty)"}`);
  } else if (!pluginId) {
    pluginId = resolvePluginId(env, opts.providerId);
  }

  const state = readState(env, pluginId);
  const runOpts = { ...opts, env };

  if (state.integrator !== "invopop" || state.integration !== "smart_receipts") {
    throw new Error(
      `Plugin ${pluginId} is ${state.integrator}/${state.integration}, not invopop/smart_receipts.`
    );
  }

  console.log(
    `\n  plugin ${state.id}, provider ${state.providerId}, account configuration ${state.accountConfigurationId}\n` +
      `  status ${state.pluginStatus}/${state.thirdPartyStatus}\n` +
      `  credentials_renewed_at      ${state.renewedAt || "null"}${
        state.expiresOn ? `  -> expires ${state.expiresOn} (${state.daysLeft} days left)` : ""
      }\n` +
      `  last_email_sent_at          ${state.lastEmailSentAt || "null"}\n` +
      `  paused_sending_documents_at ${state.pausedAt || "null"}${
        state.graceLeft ? `  -> ${state.graceLeft} days of grace left` : ""
      }`
  );

  if (!planOnly && !(await gate("Is this the plugin you mean?"))) return;

  // --- reset ---------------------------------------------------------------

  if (opts.reset) {
    const args = stampArgs(
      runOpts,
      state.id,
      {
        CREDENTIALS_RENEWED_AT: "now",
        LAST_EMAIL_SENT_AT: "null",
        PAUSED_SENDING_DOCUMENTS_AT: "null",
      },
      false
    );
    console.log(`\nreset — anchor to now, both stamps cleared, no pass\n\n  houston ${args.join(" ")}`);
    if (planOnly) return;
    if (!(await gate("Apply the reset?"))) return;
    runInherit("houston", args);
    const after = readState(env, state.id);
    console.log(
      `\n  credentials_renewed_at ${after.renewedAt || "null"}, last_email_sent_at ${
        after.lastEmailSentAt || "null"
      }, paused_sending_documents_at ${after.pausedAt || "null"}`
    );
    return;
  }

  // --- blast radius --------------------------------------------------------

  const roster = inScopePlugins(env);
  console.log(
    `\nBlast radius — ${roster.length} plugin(s) enabled or paused. Every pass settles all of\n` +
      `them, not only the target, wherever the flag is on:\n` +
      roster
        .map(
          (r) =>
            `  plugin ${String(r.id).padEnd(5)} provider ${String(r.providerId).padEnd(9)} ${r.status.padEnd(8)} expiry in ${r.daysLeft.padStart(4)}d  grace in ${r.graceLeft.padStart(3)}d${
              r.id === state.id ? "   <- target" : ""
            }`
        )
        .join("\n")
  );
  const strangers = roster.filter((r) => r.id !== state.id && r.status === "paused");
  if (strangers.length) {
    console.log(
      `\n  ${strangers.length} of them are already paused — a pass can send their grace email or\n` +
        "  disable them outright. Check the flag covers only who you think it does."
    );
  }

  if (!planOnly && !(await gate("Accept this blast radius and continue?"))) return;

  // --- enable --------------------------------------------------------------

  const needsEnable = !["enabled", "paused"].includes(state.pluginStatus);
  if (opts.enable || (!planOnly && needsEnable)) {
    const args = statusArgs(runOpts, state.accountConfigurationId);
    console.log(
      `\nenable — plugin_status and third_party_integration_status to enabled\n` +
        `  the pass only looks at enabled or paused plugins, and this one is ${state.pluginStatus}\n\n` +
        `  houston ${args.join(" ")}`
    );
    if (!planOnly) {
      if (await confirm("  Enable the plugin?")) {
        runInherit("houston", args);
        Object.assign(state, readState(env, state.id));
        console.log(`  status is now ${state.pluginStatus}/${state.thirdPartyStatus}`);
      } else if (needsEnable) {
        console.log("  skipped — the pass will ignore this plugin, so there is nothing to test.");
        return;
      } else {
        console.log("  skipped");
      }
    }
  }

  // --- case selection ------------------------------------------------------

  if (!planOnly && !opts.cases) {
    console.log(
      "\nCases:\n" +
        CASES.map((c) => `  ${String(c.id).padStart(2)}  ${c.key.padEnd(22)} ${c.phase.padEnd(6)}  ${c.name}`).join("\n")
    );
    const spec = await askDefault("Which cases?", "all");
    selected = spec.toLowerCase() === "all" ? CASES : selectCases(spec);
  }

  console.log(`\nRunning ${selected.length} case(s): ${selected.map((c) => c.id).join(", ")}`);

  // --- the ladder ----------------------------------------------------------

  const results = [];
  for (const [index, kase] of selected.entries()) {
    const ok = await runCase(kase, runOpts, state, results);
    const last = index === selected.length - 1;

    if (!ok && !planOnly) {
      // Skipped or failed, both end the run: the ladder is sequential, and every
      // later case assumes the previous email landed.
      break;
    }

    if (!planOnly && !last) {
      console.log(
        "\n  Check the mailbox and the front end now — the next case moves the clock again."
      );
      if (!(await gate(`Continue to case ${selected[index + 1].id}?`))) break;
    }
  }

  // --- summary -------------------------------------------------------------

  console.log(`\n${"=".repeat(78)}`);
  for (const r of results) {
    const mark = { pass: "PASS", fail: "FAIL", skipped: "SKIP", planned: "PLAN" }[r.outcome];
    console.log(
      `  ${mark}  ${String(r.id).padStart(2)}  ${r.key.padEnd(22)} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`
    );
  }

  if (opts.report && !planOnly && results.length) {
    console.log(`\nreport: ${writeReport(env, state, results)}`);
  }

  if (results.some((r) => r.outcome === "fail")) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\nerror: ${err.message}`);
  process.exitCode = 1;
});
