#!/usr/bin/env node
"use strict";

// confirm_comarch_uat_queue — clear a Comarch UAT queue by confirming its "sent"
// items through the edoc-online UAT REST API.
//
// Self-contained on purpose: one directory, one entrypoint, no shared library.
// Copy helpers from a sibling script rather than importing them.
//
// UAT only: the base URL is hardcoded to the UAT host, so there is no environment
// question — the banner names it. Reads are POST /api/status/sent; the one write is
// POST /api/status/sent/confirm, one per batch, each after the batch is listed and
// a typed "yes".

const readline = require("readline/promises");
const fs = require("fs");
const path = require("path");

// Load KEY=VALUE pairs from the repo-root .env into process.env, without
// overriding anything already set (real env wins). Repo root = nearest ancestor
// dir containing .env.example. Silent no-op if there's no .env.
function loadDotenv() {
  let dir = __dirname;
  while (!fs.existsSync(path.join(dir, ".env.example"))) {
    const parent = path.dirname(dir);
    if (parent === dir) return; // reached filesystem root, no marker
    dir = parent;
  }
  const envPath = path.join(dir, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}
loadDotenv();

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { header: sgr("1;37"), cmd: sgr("33"), faint: sgr("2"), ok: sgr("32"), bad: sgr("31"), warn: sgr("1;33") };

const BASE_URL = "https://edi-uat.edoc-online.com/EdiRest";
const CONFIG_TYPE = 1;
const CONFIG_IDS = {
  invoice: 119208,
  onboarding: 119286,
  aperak: 119328,
};
const QUEUES = Object.keys(CONFIG_IDS);

function usage() {
  return `confirm_comarch_uat_queue — confirm the "sent" items of a Comarch UAT queue (edoc-online UAT)

Usage:
  confirm_comarch_uat_queue [flags]

On a terminal it asks for what is left out: the queue, whether to dry run, and the
Comarch JWT unless COMARCH_UAT_JWT is set. Comarch UAT only — there is no
production path and no environment question.

Flags:
  -q, --queue QUEUE      invoice (ConfigId ${CONFIG_IDS.invoice}), onboarding (${CONFIG_IDS.onboarding})
                         or aperak (${CONFIG_IDS.aperak})
      --dry-run BOOL     true (the default): list the queue's sent items and show
                         which would be confirmed; confirm nothing. false: confirm
                         them, one batch at a time, each after a typed "yes".
                         A bare --dry-run means true
  -h, --help             show this help

Environment:
  COMARCH_UAT_JWT        the Comarch UAT JWT; asked for on a terminal when unset

Without a terminal nothing is asked: --queue and COMARCH_UAT_JWT must be given,
the run is a dry run, and --dry-run false is refused.

Exit codes: 0 done, 1 an API call failed or the operator stopped it, 2 the call was wrong.
`;
}

function fail(message, code) {
  process.stderr.write(`${c.bad("error:")} ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const o = { queue: null, dryRun: null };
  const val = (flag, v) => {
    if (v === undefined || v.startsWith("-")) fail(`${flag} takes a value`, 2);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { process.stdout.write(usage()); process.exit(0); }
    else if (a === "-q" || a === "--queue") o.queue = queueOf(val(a, argv[++i]));
    else if (a.startsWith("--queue=")) o.queue = queueOf(a.slice("--queue=".length));
    else if (a === "--dry-run") {
      // A bare --dry-run means true; a value after it says which.
      const next = argv[i + 1];
      if (next === "true" || next === "false") o.dryRun = argv[++i] === "true";
      else o.dryRun = true;
    }
    else if (a.startsWith("--dry-run=")) o.dryRun = boolOf(a.slice("--dry-run=".length));
    else if (a.startsWith("-")) fail(`unknown flag: ${a}`, 2);
    else fail(`unexpected argument ${JSON.stringify(a)} — the queue is --queue ${QUEUES.join("|")}`, 2);
  }
  return o;
}

function queueOf(v) {
  const q = String(v).toLowerCase();
  if (!QUEUES.includes(q)) fail(`--queue takes ${QUEUES.join(", ")}, got ${JSON.stringify(v)}`, 2);
  return q;
}

function boolOf(v) {
  if (v !== "true" && v !== "false") fail(`--dry-run takes true or false, got ${JSON.stringify(v)}`, 2);
  return v === "true";
}

const TERMINAL = process.stdin.isTTY && process.stdout.isTTY;
// A picker hides the cursor while it draws; whatever ends the run, it comes back.
if (TERMINAL) process.on("exit", () => process.stdout.write("\x1b[?25h"));

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
// queue and the token must be given, and the run is a dry run.
async function askMissing(o) {
  if (!TERMINAL) {
    if (!o.queue) fail(`no queue given — --queue ${QUEUES.join("|")}`, 2);
    if (o.dryRun === false) fail("--dry-run false needs a terminal: every confirmation is typed by hand", 2);
    o.dryRun = true;
    if (!process.env.COMARCH_UAT_JWT) fail("COMARCH_UAT_JWT is not set, and without a terminal there is no one to ask", 2);
  } else {
    if (!o.queue) {
      o.queue = await choose("Which queue?", QUEUES.map((q) => ({ value: q, label: q, note: `ConfigId ${CONFIG_IDS[q]}` })));
    }
    if (o.dryRun === null) {
      o.dryRun = await choose("Dry run?", [
        { value: true, label: "true", note: "list the sent items; confirm nothing" },
        { value: false, label: "false", note: "confirm them, each batch after a typed yes" },
      ]);
    }
  }
  if (process.env.COMARCH_UAT_JWT) {
    console.log("Using Comarch JWT from $COMARCH_UAT_JWT.");
    o.token = process.env.COMARCH_UAT_JWT;
  } else {
    o.token = await promptToken();
  }
  o.execute = !o.dryRun;
}

// One readline interface at a time, closed before a picker takes stdin.
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

// Stops the run: exit 1, and nothing after it runs.
class Stop extends Error {}
function stop(message) {
  throw new Stop(message);
}

const say = (s = "") => process.stdout.write(`  ${s}\n`);

async function promptToken() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const value = await ask("Comarch JWT token: ");
    if (value) return value;
    console.error("Token cannot be empty.");
  }
  throw new Error("No token provided.");
}

function buildHeaders(token) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function fetchSent(headers, configId) {
  const url = `${BASE_URL}/api/status/sent`;
  console.log(`POST ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ConfigType: CONFIG_TYPE, ConfigId: configId }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/status/sent failed (${res.status}): ${text}`);
  }

  return res.json();
}

async function confirmSent(headers, records) {
  const statusesToConfirm = records.map((r) => ({
    WebStatusId: r.WebStatusId,
    ConfigType: r.ConfigType,
    ConfigId: r.ConfigId,
  }));

  const url = `${BASE_URL}/api/status/sent/confirm`;
  console.log(`POST ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ StatusesToConfirm: statusesToConfirm }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/status/sent/confirm failed (${res.status}): ${text}`);
  }

  return res.json();
}

// The batch as it would be confirmed: one line per item, its WebStatusId first and
// the rest of the record faint beside it.
function listRecords(records, limit = 25) {
  for (const r of records.slice(0, limit)) {
    const { WebStatusId, ...rest } = r || {};
    let more = JSON.stringify(rest);
    if (more.length > 120) more = `${more.slice(0, 119)}…`;
    say(`WebStatusId ${c.header(WebStatusId)}  ${c.faint(more)}`);
  }
  if (records.length > limit) say(c.faint(`… and ${records.length - limit} more`));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await askMissing(opts);
  const configId = CONFIG_IDS[opts.queue];
  const headers = buildHeaders(opts.token);
  process.stdout.write(`\n${c.header("confirm_comarch_uat_queue")} ${opts.queue} — ${c.warn("staging (Comarch UAT)")}, DRY_RUN=${opts.dryRun} — ${opts.execute ? c.warn("confirms each batch after a typed yes") : "lists the queue only"}\n`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Using ${opts.queue} queue (ConfigId=${configId})`);

  let confirmed = 0;
  while (true) {
    console.log("Fetching sent records...");
    const records = await fetchSent(headers, configId);
    console.log(`Fetched ${records.length} record(s)`);

    if (records.length === 0) {
      console.log(confirmed ? `Queue empty. Done — ${confirmed} record(s) confirmed.` : "Queue empty. Done.");
      return 0;
    }

    listRecords(records);

    if (!opts.execute) {
      process.stdout.write(`\n  ${c.warn("would confirm")} these ${records.length} record(s): POST ${BASE_URL}/api/status/sent/confirm\n`);
      process.stdout.write(`\n${c.faint("Dry run: nothing was confirmed. --dry-run false confirms them, each batch after a typed yes.")}\n`);
      return 0;
    }

    process.stdout.write(`\n  ${c.warn("about to")} confirm these ${records.length} record(s) in ${c.warn("Comarch UAT")}:\n  ${c.cmd(`POST ${BASE_URL}/api/status/sent/confirm`)}\n`);
    const answer = (await ask(`  Type "yes" to confirm them (anything else stops): `)).toLowerCase();
    if (answer !== "yes") stop(`stopped before confirming ${records.length} record(s) — nothing more was sent${confirmed ? ` (${confirmed} confirmed earlier in this run)` : ""}`);

    console.log("Confirming all records...");
    const result = await confirmSent(headers, records);
    confirmed += records.length;
    console.log("Confirm response:", JSON.stringify(result, null, 2));
  }
}

main()
  .then((code) => { closeRl(); process.exit(code); })
  .catch((err) => {
    closeRl();
    if (err instanceof Stop) {
      process.stdout.write(`\n${c.bad("✗ stopped:")} ${err.message}\n`);
      process.exit(1);
    }
    console.error("Error:", err.message);
    process.exit(1);
  });
