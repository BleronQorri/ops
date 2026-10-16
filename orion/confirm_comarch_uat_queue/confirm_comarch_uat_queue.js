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
// the operator picks "confirm" (stop is highlighted to begin with).

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

On a terminal it asks for what is left out — the queue and whether to dry run —
with arrow-key pickers only; nothing is typed. A picked queue is followed by a
"What next?" picker to clear another one in the same run. The token comes from one
POST /api/auth per run with COMARCH_UAT_LOGIN and COMARCH_UAT_PASSWORD, kept in
memory for that run only. Comarch UAT only — there is no production path and no
environment question.

Flags:
  -q, --queue QUEUE      invoice (ConfigId ${CONFIG_IDS.invoice}), onboarding (${CONFIG_IDS.onboarding})
                         or aperak (${CONFIG_IDS.aperak})
      --dry-run BOOL     true (the default): list the queue's sent items and show
                         which would be confirmed; confirm nothing. false: confirm
                         them, one batch at a time, each after "confirm" or
                         "confirm all" is picked (stop is highlighted to begin
                         with). A bare --dry-run means true
      --confirm all      confirm every batch until the queue is empty without
                         asking — what picking "confirm all" does, decided up
                         front. Implies --dry-run false; this is the flag a timer
                         (ops schedule) needs, since it has no terminal to pick on
  -h, --help             show this help

Environment:
  COMARCH_UAT_LOGIN      the Comarch UAT login; required
  COMARCH_UAT_PASSWORD   its password; required (ops run asks for both and passes
                         them in; ops secrets set <name> saves one)

Without a terminal nothing is asked: --queue and both credentials must be given,
and the run is a dry run unless --confirm all says otherwise; --dry-run false on
its own is refused, because each batch would need a hand.

Exit codes: 0 done, 1 an API call failed or the operator stopped it, 2 the call was wrong.
`;
}

function fail(message, code) {
  process.stderr.write(`${c.bad("error:")} ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const o = { queue: null, dryRun: null, confirmAll: false };
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
    else if (a === "--confirm") o.confirmAll = confirmOf(val(a, argv[++i]));
    else if (a.startsWith("--confirm=")) o.confirmAll = confirmOf(a.slice("--confirm=".length));
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

// The only value is "all": there is no "--confirm one" — one batch at a time is
// what the picker is for.
function confirmOf(v) {
  if (v !== "all") fail(`--confirm takes all, got ${JSON.stringify(v)}`, 2);
  return true;
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

// Asks for whatever the flags left out, with pickers only. Without a terminal
// nothing is asked: the queue must be given, and the run is a dry run unless
// --confirm all has already answered every picker there would have been.
async function askMissing(o) {
  for (const name of ["COMARCH_UAT_LOGIN", "COMARCH_UAT_PASSWORD"]) {
    if (!process.env[name]) fail(`${name} is not set — ops run asks for it, or: ops secrets set ${name}`, 2);
  }
  if (o.confirmAll) {
    if (o.dryRun === true) fail("--confirm all and --dry-run true contradict each other: one confirms, the other confirms nothing", 2);
    o.dryRun = false;
  }
  if (!TERMINAL) {
    if (!o.queue) fail(`no queue given — --queue ${QUEUES.join("|")}`, 2);
    if (o.dryRun === false && !o.confirmAll) fail("--dry-run false needs a terminal: every batch is confirmed by hand — --confirm all confirms them without one", 2);
    o.dryRun = true;
  } else {
    if (!o.queue) {
      o.queue = await choose("Which queue?", QUEUES.map((q) => ({ value: q, label: q, note: `ConfigId ${CONFIG_IDS[q]}` })));
    }
    if (o.dryRun === null) {
      o.dryRun = await choose("Dry run?", [
        { value: true, label: "true", note: "list the sent items; confirm nothing" },
        { value: false, label: "false", note: "confirm them, each batch after you pick confirm" },
      ]);
    }
  }
  o.execute = !o.dryRun;
}

// One login per run: the token is kept in memory for every batch and queue of this
// run and never written down, so the next run logs in again.
async function login() {
  const url = `${BASE_URL}/api/auth`;
  console.log(`POST ${url} (login ${process.env.COMARCH_UAT_LOGIN})`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: process.env.COMARCH_UAT_LOGIN, password: process.env.COMARCH_UAT_PASSWORD }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/auth failed (${res.status}): ${text}`);
  }
  // The body is the JWT as a bare JSON string.
  const token = await res.json();
  if (typeof token !== "string" || !token) throw new Error("/api/auth returned no token");
  return token;
}

// Esc at a picker: exit 1, and nothing after it runs.
class Stop extends Error {}

const say = (s = "") => process.stdout.write(`  ${s}\n`);

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

// Works one queue until it is empty, the dry run has listed it, or the operator
// stops; returns false only when the operator stopped before a batch.
async function runQueue(opts, headers) {
  const configId = CONFIG_IDS[opts.queue];
  const mode = !opts.execute ? "lists the queue only" : opts.confirmAll ? c.warn("confirms every batch without asking (--confirm all)") : c.warn("confirms each batch after you pick confirm");
  process.stdout.write(`\n${c.header("confirm_comarch_uat_queue")} ${opts.queue} — ${c.warn("staging (Comarch UAT)")}, DRY_RUN=${opts.dryRun} — ${mode}\n`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Using ${opts.queue} queue (ConfigId=${configId})`);

  let confirmed = 0;
  let confirmAll = opts.confirmAll;
  while (true) {
    console.log("Fetching sent records...");
    const records = await fetchSent(headers, configId);
    console.log(`Fetched ${records.length} record(s)`);

    if (records.length === 0) {
      console.log(confirmed ? `Queue empty. Done — ${confirmed} record(s) confirmed.` : "Queue empty. Done.");
      return true;
    }

    listRecords(records);

    if (!opts.execute) {
      process.stdout.write(`\n  ${c.warn("would confirm")} these ${records.length} record(s): POST ${BASE_URL}/api/status/sent/confirm\n`);
      process.stdout.write(`\n${c.faint("Dry run: nothing was confirmed. --dry-run false confirms them, each batch after you pick confirm.")}\n`);
      return true;
    }

    if (!confirmAll) {
      process.stdout.write(`\n  ${c.warn("about to")} confirm these ${records.length} record(s) in ${c.warn("Comarch UAT")}:\n  ${c.cmd(`POST ${BASE_URL}/api/status/sent/confirm`)}\n`);
      const go = await choose(`Confirm these ${records.length} record(s)?`, [
        { value: "stop", label: "stop", note: "send nothing more" },
        { value: "one", label: "confirm", note: `POST /api/status/sent/confirm for ${records.length} record(s), then ask again` },
        { value: "all", label: "confirm all", note: "this batch and every next one until the queue is empty, without asking" },
      ]);
      if (go === "stop") {
        process.stdout.write(`\n${c.bad("✗ stopped:")} stopped before confirming ${records.length} record(s) — nothing more was sent${confirmed ? ` (${confirmed} confirmed earlier)` : ""}\n`);
        return false;
      }
      confirmAll = go === "all";
    }

    console.log("Confirming all records...");
    const result = await confirmSent(headers, records);
    confirmed += records.length;
    console.log("Confirm response:", JSON.stringify(result, null, 2));
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // Only a run that picked its queue goes round again; one given flags does what they say once.
  const pickedQueue = TERMINAL && !opts.queue;
  const pickedDryRun = TERMINAL && opts.dryRun === null;
  await askMissing(opts);
  const headers = buildHeaders(await login());

  let ok = await runQueue(opts, headers);
  while (pickedQueue) {
    process.stdout.write("\n");
    const next = await choose("What next?", [
      { value: "done", label: "done", note: "exit" },
      { value: "again", label: "another queue", note: "pick the queue and dry run again" },
    ]);
    if (next === "done") break;
    opts.queue = null;
    if (pickedDryRun) opts.dryRun = null;
    await askMissing(opts);
    ok = (await runQueue(opts, headers)) && ok;
  }
  return ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof Stop) {
      process.stdout.write(`\n${c.bad("✗ stopped:")} ${err.message}\n`);
      process.exit(1);
    }
    console.error("Error:", err.message);
    process.exit(1);
  });
