"use strict";

// The run store: one JSON record and one log file per run, newest id highest.
//
// Modelled on `houston task`: a run has an id, a status, the parameters it was
// given and a captured log, and stays queryable after it finishes.
//
//   <state>/runs/<id>.json   the record
//   <state>/runs/<id>.log    what it printed, when capture was possible
//
// State lives in OPS_STATE_DIR, else $XDG_STATE_HOME/ops, else ~/.local/state/ops.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const STATE_DIR =
  process.env.OPS_STATE_DIR ||
  path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "ops");
const RUNS_DIR = path.join(STATE_DIR, "orion", "runs");

// Records are small; logs are not. Keep the last KEEP runs and drop the rest,
// oldest first, so the store cannot grow without bound.
const KEEP = 500;

const STATUSES = ["running", "completed", "failed", "cancelled", "interrupted"];

function ensureDir() {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  return RUNS_DIR;
}

function recordPath(id) {
  return path.join(RUNS_DIR, `${id}.json`);
}

function logPath(id) {
  return path.join(RUNS_DIR, `${id}.log`);
}

function ids() {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs
    .readdirSync(RUNS_DIR)
    .map((f) => /^(\d+)\.json$/.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

function read(id) {
  try {
    const rec = JSON.parse(fs.readFileSync(recordPath(id), "utf8"));
    return reconcile(rec);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function write(rec) {
  ensureDir();
  fs.writeFileSync(recordPath(rec.id), JSON.stringify(rec, null, 2) + "\n");
  return rec;
}

function all() {
  return ids()
    .map(read)
    .filter(Boolean)
    .sort((a, b) => b.id - a.id);
}

// Claim the next free id. `wx` fails if the file exists, so two runs starting at
// the same moment cannot claim the same number.
function create(fields) {
  ensureDir();
  let next = (ids().pop() || 0) + 1;
  for (;;) {
    const rec = {
      id: next,
      status: "running",
      started_at: new Date().toISOString(),
      finished_at: null,
      duration_ms: null,
      exit_code: null,
      signal: null,
      initiated_by: os.userInfo().username,
      ...fields,
    };
    try {
      const fd = fs.openSync(recordPath(next), "wx");
      fs.writeSync(fd, JSON.stringify(rec, null, 2) + "\n");
      fs.closeSync(fd);
      return rec;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      next++;
    }
  }
}

function finish(rec, { code, signal }) {
  const finished = new Date();
  rec.finished_at = finished.toISOString();
  rec.duration_ms = finished - new Date(rec.started_at);
  rec.exit_code = code;
  rec.signal = signal || null;
  rec.pid = null;
  rec.status = rec.status === "cancelled" ? "cancelled" : signal ? "cancelled" : code === 0 ? "completed" : "failed";
  write(rec);
  trim();
  return rec;
}

// Is that pid still this run? A pid is reused eventually, so the entrypoint has
// to still appear in the process's command line for the answer to be yes.
function pidAlive(rec) {
  if (!rec.pid) return false;
  try {
    process.kill(rec.pid, 0);
  } catch {
    return false;
  }
  const r = spawnSync("ps", ["-p", String(rec.pid), "-o", "command="], { encoding: "utf8" });
  if (r.status !== 0) return false;
  return r.stdout.includes(path.basename(rec.entrypoint || ""));
}

// A run whose process is gone but which never recorded an ending died with its
// terminal (a closed window, a reboot). Say so rather than showing it running.
function reconcile(rec) {
  if (rec.status !== "running") return rec;
  if (pidAlive(rec)) return rec;
  rec.status = "interrupted";
  rec.finished_at = rec.finished_at || new Date().toISOString();
  rec.duration_ms = rec.duration_ms ?? new Date(rec.finished_at) - new Date(rec.started_at);
  rec.pid = null;
  try {
    write(rec);
  } catch {
    /* read-only store: report it anyway */
  }
  return rec;
}

function trim() {
  const list = ids();
  for (const id of list.slice(0, Math.max(0, list.length - KEEP))) {
    for (const p of [recordPath(id), logPath(id)]) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* already gone */
      }
    }
  }
}

module.exports = { STATE_DIR, RUNS_DIR, KEEP, STATUSES, ensureDir, recordPath, logPath, ids, read, write, all, create, finish, pidAlive, trim };
