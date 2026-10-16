"use strict";

// The schedule store and the two schedulers it drives.
//
// A schedule is `ops run <script> …` on a timer, owned by the operating system's
// own scheduler so it survives a closed terminal and a reboot: launchd on macOS
// (a user agent in ~/Library/LaunchAgents, which also catches up a run missed
// while the machine slept), crontab anywhere else. ops keeps its own record of
// each one so `ops schedule ls` can say what is scheduled without parsing a
// plist or a crontab back:
//
//   <state>/orion/schedules/<name>.json   the record
//   <state>/orion/schedules/<name>.log    what the scheduler saw on stdout/stderr
//
// The timed command is `ops run`, not the script, so every firing is a run record
// with a log (`ops task ls --schedule <name>`), and the script sees exactly what
// it would see from `ops run` in a pipe: no terminal, so it asks nothing and the
// saved secrets reach it from .env the usual way. Nothing secret is written into
// the plist or the crontab line — only the command, its arguments and `-p`
// parameters, which are already plain text in every run record.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const runs = require("./runs");
const { UsageError } = require("../ui");

const DIR = path.join(runs.STATE_DIR, "orion", "schedules");
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const LABEL_PREFIX = "ops.schedule.";
const CRON_MARK = "# ops schedule ";

// Which scheduler runs the timer. OPS_SCHEDULER=crontab forces crontab on a Mac,
// which is only useful for looking at the line it would write.
function backend() {
  if (process.env.OPS_SCHEDULER === "crontab" || process.env.OPS_SCHEDULER === "launchd") return process.env.OPS_SCHEDULER;
  return process.platform === "darwin" ? "launchd" : "crontab";
}

function checkName(name) {
  if (!NAME_RE.test(String(name))) throw new UsageError(`invalid schedule name: ${name}`, "names are lowercase letters, digits, _ and -, starting with a letter or digit");
  return name;
}

// --- the store ---------------------------------------------------------------

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
  return DIR;
}

function recordPath(name) {
  return path.join(DIR, `${name}.json`);
}

function logPath(name) {
  return path.join(DIR, `${name}.log`);
}

function read(name) {
  try {
    return JSON.parse(fs.readFileSync(recordPath(checkName(name)), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function write(rec) {
  ensureDir();
  fs.writeFileSync(recordPath(rec.name), JSON.stringify(rec, null, 2) + "\n");
  return rec;
}

function remove(name) {
  for (const p of [recordPath(name), logPath(name)]) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* already gone */
    }
  }
}

function all() {
  if (!fs.existsSync(DIR)) return [];
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => read(f.slice(0, -5)))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// --- the timer ---------------------------------------------------------------

// "5h", "30m", "1d" -> seconds. Weeks are not a cron unit, so a schedule's
// duration stops at days.
function everySeconds(spec) {
  const m = /^(\d+)\s*(m|h|d)$/.exec(String(spec).trim());
  if (!m || Number(m[1]) < 1) throw new UsageError(`invalid --every value: ${spec}`, "use forms like 30m, 5h, 1d");
  return Number(m[1]) * { m: 60, h: 3600, d: 86400 }[m[2]];
}

// One cron field -> the values it names, or null for "every". `*`, `n`, `a-b`,
// `*/n`, `a-b/n` and comma lists of those.
function cronField(field, lo, hi, what) {
  if (field === "*") return null;
  const out = new Set();
  for (const part of field.split(",")) {
    const m = /^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new UsageError(`invalid cron ${what} field: ${field}`, "fields are *, n, a-b, */n, a-b/n or a comma list of those");
    let [from, to] = m[1] === "*" ? [lo, hi] : m[1].includes("-") ? m[1].split("-").map(Number) : [Number(m[1]), Number(m[1])];
    const step = m[2] ? Number(m[2]) : 1;
    if (from < lo || to > hi || from > to || step < 1) throw new UsageError(`cron ${what} field out of range: ${part}`, `${what} is ${lo}-${hi}`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

// A five-field cron expression, checked and taken apart. Names (jan, mon) are
// not accepted: a number means the same thing on both schedulers.
function parseCron(expr) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) throw new UsageError(`invalid --cron value: ${expr}`, 'five fields: "minute hour day-of-month month day-of-week", e.g. "0 */5 * * *"');
  return {
    expr: fields.join(" "),
    minute: cronField(fields[0], 0, 59, "minute"),
    hour: cronField(fields[1], 0, 23, "hour"),
    day: cronField(fields[2], 1, 31, "day-of-month"),
    month: cronField(fields[3], 1, 12, "month"),
    weekday: cronField(fields[4], 0, 7, "day-of-week"),
  };
}

// `--every` as a cron line, for the crontab backend. Only an interval that
// divides its unit evenly can be written as */n; the rest is a --cron job.
function everyAsCron(seconds) {
  if (seconds % 86400 === 0) {
    const d = seconds / 86400;
    if (d === 1) return "0 0 * * *";
    throw new UsageError(`--every ${d}d cannot be written as a cron line`, 'crontab has no "every n days" — give the days with --cron, e.g. "0 0 */2 * *"');
  }
  if (seconds % 3600 === 0) {
    const h = seconds / 3600;
    if (24 % h === 0) return h === 1 ? "0 * * * *" : `0 */${h} * * *`;
    throw new UsageError(`--every ${h}h does not divide the day evenly`, "crontab repeats from midnight, so use a divisor of 24 or give the hours with --cron");
  }
  const m = seconds / 60;
  if (60 % m === 0) return m === 1 ? "* * * * *" : `*/${m} * * * *`;
  throw new UsageError(`--every ${m}m does not divide the hour evenly`, "crontab repeats from the top of the hour, so use a divisor of 60 or give the minutes with --cron");
}

// The command the scheduler runs. node and bin/ops by absolute path so the
// timer does not depend on PATH to find ops; PATH itself is still carried
// across, because the script's own `#!/usr/bin/env node` (or elixir) needs it
// and a scheduler starts with almost none.
function command(rec) {
  const argv = [process.execPath, path.resolve(__dirname, "..", "..", "bin", "ops"), "run"];
  for (const [k, v] of Object.entries(rec.params || {})) argv.push("-p", `${k}=${v}`);
  argv.push(rec.script, ...rec.args);
  return argv;
}

// The environment a scheduled run starts with: where ops keeps its stores (so
// the schedule points at the same catalogue, config, runs and .env as the
// terminal that made it), PATH, and the schedule's own name for the run record.
function environment(rec) {
  const env = { PATH: rec.path, OPS_SCHEDULE: rec.name };
  for (const k of ["OPS_ORION_SCRIPTS", "OPS_CONFIG_DIR", "OPS_STATE_DIR", "OPS_ENV_FILE"]) if (process.env[k]) env[k] = process.env[k];
  return env;
}

// --- launchd -----------------------------------------------------------------

const AGENTS_DIR = path.join(os.homedir(), "Library", "LaunchAgents");

function launchdLabel(name) {
  return LABEL_PREFIX + name;
}

function plistPath(name) {
  return path.join(AGENTS_DIR, `${launchdLabel(name)}.plist`);
}

function xml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// StartCalendarInterval takes one dict per combination of the listed fields; a
// `*` field is left out of the dict, which launchd reads as "any". The product
// is bounded by the cron ranges, so a dense expression is still a few hundred.
function calendarIntervals(cron) {
  let dicts = [{}];
  const expand = (key, values) => {
    if (values === null) return;
    dicts = dicts.flatMap((d) => values.map((v) => ({ ...d, [key]: v })));
  };
  expand("Minute", cron.minute);
  expand("Hour", cron.hour);
  expand("Day", cron.day);
  expand("Month", cron.month);
  // launchd has no Sunday-as-7; cron does.
  expand("Weekday", cron.weekday && [...new Set(cron.weekday.map((d) => d % 7))]);
  return dicts;
}

function plist(rec) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">', '<plist version="1.0">', "<dict>"];
  const kv = (k, v) => lines.push(`  <key>${k}</key>`, `  ${v}`);
  kv("Label", `<string>${xml(launchdLabel(rec.name))}</string>`);
  kv("ProgramArguments", `<array>\n${command(rec).map((a) => `    <string>${xml(a)}</string>`).join("\n")}\n  </array>`);
  kv("WorkingDirectory", `<string>${xml(rec.cwd)}</string>`);
  kv("EnvironmentVariables", `<dict>\n${Object.entries(environment(rec)).map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join("\n")}\n  </dict>`);
  if (rec.every) kv("StartInterval", `<integer>${everySeconds(rec.every)}</integer>`);
  else {
    const dicts = calendarIntervals(parseCron(rec.cron));
    const one = (d) => `<dict>${Object.entries(d).map(([k, v]) => `<key>${k}</key><integer>${v}</integer>`).join("")}</dict>`;
    kv("StartCalendarInterval", dicts.length === 1 ? one(dicts[0]) : `<array>\n${dicts.map((d) => `    ${one(d)}`).join("\n")}\n  </array>`);
  }
  kv("StandardOutPath", `<string>${xml(logPath(rec.name))}</string>`);
  kv("StandardErrorPath", `<string>${xml(logPath(rec.name))}</string>`);
  kv("ProcessType", "<string>Background</string>");
  lines.push("</dict>", "</plist>", "");
  return lines.join("\n");
}

function launchctl(args) {
  const r = spawnSync("launchctl", args, { encoding: "utf8" });
  return { ok: !r.error && r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}`.trim(), error: r.error };
}

function domain() {
  return `gui/${process.getuid()}`;
}

function launchdInstall(rec) {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const p = plistPath(rec.name);
  fs.writeFileSync(p, plist(rec));
  // A plist already loaded (a replaced schedule) has to come out first;
  // bootstrap refuses a label that is already there.
  launchctl(["bootout", `${domain()}/${launchdLabel(rec.name)}`]);
  const r = launchctl(["bootstrap", domain(), p]);
  if (!r.ok) throw new UsageError(`launchctl could not load ${p}: ${r.out || r.error?.message || "unknown error"}`);
  return p;
}

function launchdRemove(name) {
  launchctl(["bootout", `${domain()}/${launchdLabel(name)}`]);
  try {
    fs.unlinkSync(plistPath(name));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}

function launchdLoaded(name) {
  return launchctl(["print", `${domain()}/${launchdLabel(name)}`]).ok;
}

function launchdKick(name) {
  const r = launchctl(["kickstart", `${domain()}/${launchdLabel(name)}`]);
  if (!r.ok) throw new UsageError(`launchctl could not start ${launchdLabel(name)}: ${r.out || r.error?.message || "unknown error"}`, `is it loaded? \`ops schedule ls\``);
}

// --- crontab -----------------------------------------------------------------

function shq(s) {
  return /^[A-Za-z0-9_\/.=:,@%+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// One crontab line, marked so it can be found again. Variables are set inline
// because a crontab's own KEY=value lines are global to the file.
function cronLine(rec) {
  const expr = rec.every ? everyAsCron(everySeconds(rec.every)) : parseCron(rec.cron).expr;
  const env = Object.entries(environment(rec)).map(([k, v]) => `${k}=${shq(v)}`);
  const cmd = ["cd", shq(rec.cwd), "&&", ...env, ...command(rec).map(shq), ">>", shq(logPath(rec.name)), "2>&1"].join(" ");
  return `${CRON_MARK}${rec.name}\n${expr} ${cmd}`;
}

function crontabRead() {
  const r = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (r.error) throw new UsageError(`crontab is not available: ${r.error.message}`);
  // "no crontab for <user>" is exit 1 and an empty table
  if (r.status !== 0) return "";
  return r.stdout;
}

function crontabWrite(text) {
  const r = spawnSync("crontab", ["-"], { input: text, encoding: "utf8" });
  if (r.error || r.status !== 0) throw new UsageError(`crontab refused the table: ${(r.stderr || r.error?.message || "").trim()}`);
}

// Drop this schedule's marker line and the line after it.
function crontabWithout(text, name) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === `${CRON_MARK}${name}`) {
      i++; // the job line
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

function crontabInstall(rec) {
  const rest = crontabWithout(crontabRead(), rec.name).replace(/\n*$/, "");
  crontabWrite(`${rest ? rest + "\n" : ""}${cronLine(rec)}\n`);
  return "crontab";
}

function crontabRemove(name) {
  const text = crontabRead();
  if (!text.includes(`${CRON_MARK}${name}\n`)) return;
  const rest = crontabWithout(text, name);
  // The last line out takes the table with it, so `crontab -l` says "no crontab"
  // again rather than printing an empty one.
  if (rest.trim() === "") spawnSync("crontab", ["-r"], { encoding: "utf8" });
  else crontabWrite(rest);
}

function crontabLoaded(name) {
  return crontabRead().includes(`${CRON_MARK}${name}\n`);
}

// cron has no "run it now": the command is run here instead, in the
// background, detached, so the terminal gets its prompt back.
function crontabKick(rec) {
  const { spawn } = require("child_process");
  const fd = fs.openSync(logPath(rec.name), "a");
  const [exe, ...args] = command(rec);
  const child = spawn(exe, args, { cwd: rec.cwd, env: { ...process.env, ...environment(rec) }, detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  fs.closeSync(fd);
}

// --- the one API the commands use -----------------------------------------------

function install(rec) {
  ensureDir();
  rec.backend = backend();
  rec.installed = rec.backend === "launchd" ? launchdInstall(rec) : crontabInstall(rec);
  return write(rec);
}

function uninstall(rec) {
  if (rec.backend === "launchd") launchdRemove(rec.name);
  else crontabRemove(rec.name);
  remove(rec.name);
}

function loaded(rec) {
  return rec.backend === "launchd" ? launchdLoaded(rec.name) : crontabLoaded(rec.name);
}

function kick(rec) {
  if (rec.backend === "launchd") launchdKick(rec.name);
  else crontabKick(rec);
}

// What the scheduler would be given, for `ops schedule get`.
function rendered(rec) {
  return rec.backend === "launchd" ? plist(rec) : cronLine(rec) + "\n";
}

// The most recent run this schedule started, if any.
function lastRun(name) {
  return runs.all().find((r) => r.schedule === name) || null;
}

module.exports = { DIR, NAME_RE, backend, checkName, read, write, remove, all, logPath, recordPath, everySeconds, parseCron, everyAsCron, calendarIntervals, command, environment, plist, cronLine, install, uninstall, loaded, kick, rendered, lastRun };
