"use strict";

// `ops orion task` — the run lifecycle, shaped like `houston task`:
//
//   run     run a script, record it, capture what it printed
//   ls      list runs, newest first, with filters
//   get     one run's record
//   logs    what that run printed
//   rerun   the same script, args and params again
//   cancel  stop a run that is still going
//
// The scripts themselves are untouched: ops spawns the entrypoint with the
// caller's cwd and terminal, adds no prompts and removes none.

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const ui = require("../ui");
const { c, cerr, UsageError, ProblemsError } = ui;
const cat = require("./catalogue");
const runs = require("./runs");

const SIGNALS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGQUIT: 3, SIGKILL: 9 };
const PARAM_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CANCEL_GRACE_MS = 5000;

// --- helpers -----------------------------------------------------------------

function tierLabel(script) {
  return script.tier ? `${script.tier} — ${cat.TIERS[script.tier]?.label ?? ""}` : "tier unknown (no frontmatter)";
}

// One line before the script starts. A production write is red, and says so in
// words as well as colour, because colour is the first thing a pipe throws away.
function banner(rec, script) {
  const prod = cat.isProdWrite(script.tier);
  const bits = [cat.paintTier(`${script.env} · ${script.access} · ${tierLabel(script)}`, script.tier, cerr)];
  if (prod) bits.unshift(cerr.bad("⚠ PRODUCTION WRITE"));
  if (script.status === "deprecated") bits.unshift(cerr.warn("DEPRECATED"));
  return `${cerr.faint("ops ▸")} ${cerr.bold(`run ${rec.id}`)}  ${cerr.bold(rec.label)}  ${bits.join("  ")}`;
}

function human(ms) {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

function ago(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 86_400_000) return `${human(ms)} ago`;
  const d = Math.floor(ms / 86_400_000);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

// "30m", "2h", "7d" -> milliseconds
function duration(spec) {
  const m = /^(\d+)\s*(s|m|h|d|w)$/.exec(String(spec).trim());
  if (!m) throw new UsageError(`invalid duration: ${spec}`, "use forms like 30m, 12h, 7d");
  return Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2]];
}

function statusMark(status) {
  const paint = { completed: c.ok, failed: c.bad, cancelled: c.warn, interrupted: c.warn, running: c.sql }[status] || ((x) => x);
  return process.stdout.isTTY ? paint(status) : status;
}

// commander calls this with no accumulator the first time, and no default is
// given so the flag's help line stays clean.
function collect(v, acc = []) {
  acc.push(v);
  return acc;
}

// -p KEY=VALUE, repeatable, houston's parameter syntax. They reach the script as
// environment variables, which is how houston passes them to run_task.sh too.
function parseParams(list) {
  const out = {};
  for (const item of list) {
    const eq = String(item).indexOf("=");
    if (eq < 1) throw new UsageError(`invalid parameter: ${item}`, "parameters are KEY=VALUE");
    const key = item.slice(0, eq);
    if (!PARAM_KEY_RE.test(key)) throw new UsageError(`invalid parameter name: ${key}`, "names are letters, digits and _, not starting with a digit");
    out[key] = item.slice(eq + 1);
  }
  return out;
}

function resolve(token, reserved) {
  const catalogue = cat.loadCatalogue({ reserved });
  const target = cat.resolveTarget(catalogue, token);
  const s = target.script;
  if (s.docOnly) {
    throw new UsageError(`${s.name} is documentation only (${s.status}) — there is nothing to run`, `Read it with \`ops orion script view ${s.name}\`.${s.blocked_on ? ` Blocked on: ${s.blocked_on}` : ""}`);
  }
  if (s.retired) {
    throw new UsageError(
      `${s.name} is retired — ${s.retired_reason || "decommissioned"}`,
      `Read it with \`ops orion script view ${s.name}\`. If you really need it, the file still runs on its own: ${target.exe}`
    );
  }
  if (!target.exe) throw new UsageError(`${s.name} has no entrypoint`, "check its AGENTS.md frontmatter (`ops orion docs check`)");
  if (!cat.isExecutable(target.exe)) throw new UsageError(`${path.relative(catalogue.root, target.exe)} is not executable`, `chmod +x ${target.exe}`);
  return { catalogue, ...target };
}

// --- running -----------------------------------------------------------------

// Can script(1) actually give us a pty here? It cannot without a controlling
// terminal — inside CI, some IDE consoles, or another pty-less parent — and it
// fails with "tcgetattr/ioctl: Operation not supported on socket" rather than
// running the command. Probing once with a no-op is cheap and keeps a run from
// being lost to a capture mechanism that was never going to work.
let PTY_OK = null;
function canPty() {
  if (PTY_OK === null) {
    const r = spawnSync("script", ["-q", "-e", "/dev/null", "true"], { encoding: "utf8", timeout: 5000 });
    PTY_OK = !r.error && r.status === 0 && !/ioctl|not supported/i.test(`${r.stderr || ""}${r.stdout || ""}`);
  }
  return PTY_OK;
}

// How a run is captured depends on what the caller's terminal is, because the
// script must see exactly what it would see if you typed its path:
//
//   stdin tty + stdout tty  ->  script(1) gives it a real pty and tees to the log
//   stdin piped + stdout tty -> fds inherited, nothing captured (script(1) would
//                               swallow the piped stdin, changing the run)
//   stdout piped            ->  pipes, captured; the script sees a pipe either way
//
// Capture is always the thing that gives way: if a pty is not available, the run
// still happens, unrecorded, rather than not happening.
function captureMode(wantLog) {
  if (!wantLog) return "none";
  if (!process.stdout.isTTY) return "pipe";
  if (process.stdin.isTTY && canPty()) return "pty";
  return "none";
}

function execRun(rec, exe, args, mode) {
  return new Promise((resolve_) => {
    const env = { ...process.env, ...(rec.params || {}) };
    const opts = { cwd: rec.cwd, env };
    let child;
    let sink = null;

    if (mode === "pty") {
      // -q: no "Script started" preamble. -e: exit with the child's status.
      child = spawn("script", ["-q", "-e", rec.log, exe, ...args], { ...opts, stdio: "inherit" });
    } else if (mode === "pipe") {
      child = spawn(exe, args, { ...opts, stdio: ["inherit", "pipe", "pipe"] });
      sink = fs.createWriteStream(rec.log);
      child.stdout.on("data", (d) => {
        process.stdout.write(d);
        sink.write(d);
      });
      child.stderr.on("data", (d) => {
        process.stderr.write(d);
        sink.write(d);
      });
    } else {
      child = spawn(exe, args, { ...opts, stdio: "inherit" });
    }

    rec.pid = child.pid;
    runs.write(rec);

    // Ctrl-C belongs to the script while it lives.
    const ignore = () => {};
    process.on("SIGINT", ignore);
    process.on("SIGTERM", ignore);

    child.on("error", (err) => {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", ignore);
      ui.eprint(`${cerr.bad("error:")} could not start ${exe}: ${err.message}`);
      resolve_({ code: 2, signal: null, failedToStart: true });
    });

    child.on("exit", (code, signal) => {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", ignore);
      if (sink) sink.end();
      resolve_({ code: code ?? 128 + (SIGNALS[signal] ?? 0), signal });
    });
  });
}

function hintMisplacedFlags(args) {
  const i = args.findIndex((a) => a === "-p" || a === "--param");
  if (i !== -1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i + 1] || "")) {
    ui.eprint(cerr.faint("  (note: ops flags go before the script name — 'ops task run -p KEY=VALUE <script> …'; this one went to the script)"));
  }
  if (args.includes("--no-log")) {
    ui.eprint(cerr.faint("  (note: --no-log goes before the script name; this one went to the script)"));
  }
}

async function doRun({ token, args, params, log, reserved, rerunOf }) {
  const { script, exe, label } = resolve(token, reserved);
  if (args[0] === "--") args = args.slice(1);

  const rec = runs.create({
    script: script.name,
    label,
    entrypoint: exe,
    args,
    params,
    env: script.env,
    access: script.access,
    tier: script.tier ?? null,
    script_status: script.status,
    cwd: process.cwd(),
    log: null,
    captured: "none",
    rerun_of: rerunOf ?? null,
    pid: null,
  });

  const mode = captureMode(log);
  rec.captured = mode;
  rec.log = mode === "none" ? null : runs.logPath(rec.id);
  runs.write(rec);

  ui.eprint(banner(rec, script));
  hintMisplacedFlags(args);
  if (log && mode === "none") {
    ui.eprint(
      cerr.faint(
        !process.stdin.isTTY
          ? "  (output not captured: stdin is not a terminal, so the script keeps your fds)"
          : "  (output not captured: no pty available for script(1))"
      )
    );
  }

  const { code, signal, failedToStart } = await execRun(rec, exe, args, mode);
  if (failedToStart) {
    rec.status = "failed";
    runs.finish(rec, { code, signal });
    return 2;
  }
  runs.finish(rec, { code, signal });
  ui.eprint(
    `${cerr.faint("ops ▸")} run ${rec.id} ${statusMark(rec.status)} in ${human(rec.duration_ms)}` +
      (signal ? ` (${signal})` : ` (exit ${code})`) +
      (rec.log ? cerr.faint(`  · ops task logs ${rec.id}`) : "")
  );
  return code;
}

// --- rendering ---------------------------------------------------------------

// The script's name carries its tier's colour, so a production write is red in the
// history too.
function scriptCell(rec) {
  return process.stdout.isTTY ? cat.paintTier(rec.script, rec.tier, c) : rec.script;
}

function argsCell(rec) {
  const parts = [...(rec.args || [])];
  for (const [k, v] of Object.entries(rec.params || {})) parts.push(`-p ${k}=${v}`);
  return parts.join(" ");
}

function detail(rec) {
  const rows = [
    ["Run", String(rec.id)],
    ["Status", statusMark(rec.status) + (rec.exit_code === null ? "" : `  (exit ${rec.exit_code}${rec.signal ? `, ${rec.signal}` : ""})`)],
    ["Script", rec.label || rec.script],
    ["Tier", rec.tier ? cat.paintTier(`${rec.tier} — ${cat.TIERS[rec.tier]?.label ?? ""}`, rec.tier, c) : "—"],
    ["Env", `${rec.env} · ${rec.access}`],
    ["Args", (rec.args || []).join(" ") || c.faint("none")],
    ["Params", Object.entries(rec.params || {}).map(([k, v]) => `${k}=${v}`).join(" ") || c.faint("none")],
    ["Started", `${rec.started_at}  (${ago(rec.started_at)})`],
    ["Duration", human(rec.duration_ms)],
    ["By", rec.initiated_by],
    ["Directory", rec.cwd],
    ["Entrypoint", rec.entrypoint],
  ];
  if (rec.rerun_of) rows.push(["Rerun of", String(rec.rerun_of)]);
  if (rec.pid) rows.push(["Pid", String(rec.pid)]);
  rows.push(["Log", rec.log ? `${rec.log}  (${rec.captured})` : c.faint("not captured")]);
  return rows.map(([k, v]) => `  ${ui.pad(k, 11)} ${v}`).join("\n");
}

// script(1) writes a pty stream: CR line endings and a trailing EOT.
function cleanLog(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\x04/g, "");
}

function readLog(rec) {
  if (!rec.log) return null;
  try {
    return fs.readFileSync(rec.log, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function requireRun(id) {
  if (!/^\d+$/.test(String(id))) throw new UsageError(`invalid run id: ${id}`, "ids are numbers — see `ops task ls`");
  const rec = runs.read(Number(id));
  if (!rec) throw new ProblemsError(`no run with id ${id}`);
  return rec;
}

// --- commands ----------------------------------------------------------------

// `ops run <script>` and `ops task run <script>` are the same command, built twice
// so both spellings carry the same flags, help and behaviour.
function addRun(parent, reserved) {
  const { gh } = require("../program");
  const run = parent
    .command("run")
    .summary("Run a script, record the run and capture its output")
    .description("Run a script by name or alias. Everything after the script token is handed to the script exactly as typed, including `--help`, so `ops task run ri --help` shows the script's help and `ops task run --help` shows this page.\n\nThe script runs in your current directory with your terminal attached, so its prompts, TTY gates, reports and exit code are identical to running the file directly. ops prints one line on stderr before it starts, naming the run id, environment, access and danger tier, and one line after it with the status. It adds no confirmation of its own.\n\nops' own flags go before the script name, because everything after it belongs to the script: `ops task run -p PROVIDER_ID=1 pms 646845`.\n\nOutput is captured to a log when that can be done without changing what the script sees: on a terminal through script(1), which gives the script a real pty, and otherwise through pipes. When stdin is piped but stdout is a terminal, nothing is captured, because a pty there would swallow the piped input.")
    .argument("<script>", "script name, alias, or <name>/<file> for a secondary entrypoint")
    .argument("[args...]", "arguments for the script")
    .option("-p, --param <KEY=VALUE>", "parameter passed to the script as an environment variable; repeatable. Must precede <script>", collect)
    .option("--no-log", "do not capture the output")
    .passThroughOptions()
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (token, args, opts) => {
      process.exitCode = await doRun({ token, args, params: parseParams(opts.param || []), log: opts.log !== false, reserved });
    });
  gh(run, {
    usage: ["[flags] <script> [<script-args>...]"],
    examples: [
      { cmd: "ops task run resend_stuck_invoices --dry-run 123,456" },
      { cmd: "ops task run ri --help", note: "the script's own help (alias from its frontmatter)" },
      { cmd: "ops task run -p INVOPOP_API_TOKEN=… isc --problems", note: "parameters reach the script as environment variables, and go before the script name" },
      { cmd: "ops task run match_credit_notes_to_invoices/decode_payloads --ids 1 --yes", note: "a secondary entrypoint" },
      { cmd: "cd ~/reports && ops task run plugin_legal_entity_updates", note: "reports land in the current directory" },
    ],
  });
  if (!parent.parent) run.helpGroup("SCRIPT COMMANDS");
}


// Registered on the root program, not under a group: running a script is the thing
// this tool is for, so it is `ops run <script>` and `ops task ls`, one word deep.
function register(program, { reserved }) {
  const { gh } = require("../program");

  // `ops run` first, because it is the one anyone types.
  addRun(program, reserved);

  const task = program
    .command("task")
    .summary("Inspect and re-run past script runs")
    .description("Every script run is recorded, the way `houston task` does it: an id, a status, the arguments and parameters it was given, timing, and a captured log, all queryable afterwards.\n\nRuns are recorded under $OPS_STATE_DIR (default ~/.local/state/ops/orion/runs); the newest 500 are kept.")
    .helpGroup("SCRIPT COMMANDS")
    .enablePositionalOptions();
  gh(task, {
    examples: [
      { cmd: "ops task ls --script ri" },
      { cmd: "ops task get 42" },
      { cmd: "ops task logs 42" },
      { cmd: "ops task rerun 42" },
    ],
    learnMore: ["To start a run: `ops run <script> [args...]` (also `ops task run`)."],
  });

  // ---- run: the same command again, as `ops task run`
  addRun(task, reserved);

  // ---- ls
  const ls = task
    .command("ls")
    .alias("list")
    .summary("List runs, most recent first")
    .description("List recorded runs, newest first.\n\n`--script` and `--initiated-by` are case-insensitive substring matches. `--status` matches exactly. `--param` filters by the parameters a run was given, scoped to a named key: `KEY=VALUE` matches the whole value or one whole comma-separated token of it, `KEY~VALUE` matches any value containing VALUE. Keys are matched case-insensitively. All filters combine with AND.")
    .option("-s, --script <name>", "only runs of scripts whose name contains this")
    .option("--status <status>", `only runs in this status (${runs.STATUSES.join(", ")}); repeatable`, collect)
    .option("-p, --param <KEY=VALUE>", "only runs given this parameter; KEY~VALUE for a partial value; repeatable", collect)
    .option("--initiated-by <who>", "only runs started by this user")
    .option("--since <duration>", "only runs started within this window, e.g. 2h or 7d")
    .option("-L, --limit <n>", "how many to show (default 20)", "20")
    .option("--json", "output JSON instead of a table")
    .action((opts) => {
      for (const st of opts.status || []) {
        if (!runs.STATUSES.includes(st)) throw new UsageError(`invalid --status value: ${st}`, `allowed: ${runs.STATUSES.join(", ")}`);
      }
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new UsageError(`invalid --limit value: ${opts.limit}`);
      const cutoff = opts.since ? Date.now() - duration(opts.since) : null;

      let list = runs.all();
      if (opts.script) list = list.filter((r) => (r.script || "").toLowerCase().includes(opts.script.toLowerCase()));
      if (opts.status?.length) list = list.filter((r) => opts.status.includes(r.status));
      if (opts.initiatedBy) list = list.filter((r) => (r.initiated_by || "").toLowerCase().includes(opts.initiatedBy.toLowerCase()));
      if (cutoff) list = list.filter((r) => new Date(r.started_at).getTime() >= cutoff);
      for (const filter of opts.param || []) list = list.filter((r) => matchesParam(r, filter));
      list = list.slice(0, limit);

      if (opts.json) return process.stdout.write(ui.json(list));
      if (!list.length) {
        if (process.stdout.isTTY) ui.eprint(c.faint("no runs match"));
        return;
      }
      process.stdout.write(
        ui.table(
          list.map((r) => [String(r.id), statusMark(r.status), scriptCell(r), ago(r.started_at), human(r.duration_ms), argsCell(r)]),
          ["ID", "STATUS", "SCRIPT", "STARTED", "DURATION", "ARGS"]
        )
      );
    });
  gh(ls, {
    usage: ["[flags]"],
    examples: [
      { cmd: "ops task ls" },
      { cmd: "ops task ls --script retry --status failed" },
      { cmd: "ops task ls --param PROVIDER_IDS=123", note: "matches one token of a comma-separated value" },
      { cmd: "ops task ls --since 7d --json | jq -r '.[] | [.id, .script, .status] | @tsv'" },
    ],
  });

  // ---- get
  const get = task
    .command("get")
    .summary("Show one run's record")
    .description("Show everything recorded about a run: status and exit code, the script and its tier, the arguments and parameters it was given, when it ran, for how long, from which directory, and where its log is. With a captured log, the last lines are shown too.")
    .argument("<id>", "run id")
    .option("--json", "output the record as JSON")
    .option("-n, --tail <n>", "lines of the log to show (default 20)", "20")
    .action((id, opts) => {
      const rec = requireRun(id);
      if (opts.json) return process.stdout.write(ui.json(rec));
      process.stdout.write(`${detail(rec)}\n`);
      const text = readLog(rec);
      if (text) {
        const n = Number(opts.tail);
        const lines = cleanLog(text).replace(/\n+$/, "").split("\n");
        const shown = Number.isInteger(n) && n > 0 ? lines.slice(-n) : lines;
        process.stdout.write(`\n${ui.section(`LOG  ${c.faint(`(last ${shown.length} of ${lines.length} lines — ops task logs ${rec.id})`)}`, shown.map((l) => `  ${l}`).join("\n"))}\n`);
      }
      if (rec.status === "failed") throw new ProblemsError("");
    });
  gh(get, { usage: ["<id> [flags]"], examples: [{ cmd: "ops task get 42" }, { cmd: "ops task get 42 --json | jq .params" }] });

  // ---- logs
  const logs = task
    .command("logs")
    .summary("Print what a run printed")
    .description("Print a run's captured output. Carriage returns and the pty end-of-transmission byte are stripped so the log reads as plain text; `--raw` prints the bytes as they were recorded, escape sequences and all.\n\nNot every run has a log: when stdin is piped and stdout is a terminal, ops leaves the script's file descriptors alone rather than change what it sees, and captures nothing.")
    .argument("<id>", "run id")
    .option("--raw", "print the recorded bytes unmodified")
    .option("--no-pager", "do not pipe through a pager")
    .action((id, opts) => {
      const rec = requireRun(id);
      const text = readLog(rec);
      if (text === null) {
        throw new ProblemsError(rec.captured === "none" ? `run ${rec.id} has no captured log (captured: none)` : `run ${rec.id}'s log file is gone`);
      }
      const out = opts.raw ? text : cleanLog(text);
      if (opts.pager === false) process.stdout.write(out);
      else ui.pager(out);
    });
  gh(logs, { usage: ["<id> [flags]"], examples: [{ cmd: "ops task logs 42" }, { cmd: "ops task logs 42 --no-pager | grep ERROR" }] });

  // ---- rerun
  const rerun = task
    .command("rerun")
    .summary("Run a previous run again, with the same arguments")
    .description("Fetch a previous run's script, arguments and parameters, and run it again from your current directory. Arguments you pass replace the originals; `-p` parameters are merged over them.\n\nThe new run gets its own id and records which run it came from. Nothing about the original is changed.")
    .argument("<id>", "run id")
    .argument("[args...]", "arguments to use instead of the original ones")
    .option("-p, --param <KEY=VALUE>", "parameter to add or override; repeatable. Must precede any replacement arguments", collect)
    .option("--no-log", "do not capture the output")
    .passThroughOptions()
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (id, args, opts) => {
      const rec = requireRun(id);
      const params = { ...(rec.params || {}), ...parseParams(opts.param || []) };
      const useArgs = args.length ? args : rec.args || [];
      ui.eprint(cerr.faint(`ops ▸ rerunning run ${rec.id}: ${rec.script} ${useArgs.join(" ")}`));
      process.exitCode = await doRun({ token: rec.script, args: useArgs, params, log: opts.log !== false, reserved, rerunOf: rec.id });
    });
  gh(rerun, {
    usage: ["[flags] <id> [<script-args>...]"],
    examples: [{ cmd: "ops task rerun 42" }, { cmd: "ops task rerun 42 --dry-run 999", note: "same script, different arguments" }],
  });

  // ---- cancel
  const cancel = task
    .command("cancel")
    .summary("Stop a run that is still going")
    .description("Send SIGTERM to a running run's process, then SIGKILL if it is still alive after five seconds, and mark it cancelled.\n\nThe pid is checked against the entrypoint's name first, so a reused pid is never signalled. A run started in another terminal keeps printing there; only its process is stopped.")
    .argument("<id>", "run id")
    .action(async (id) => {
      const rec = requireRun(id);
      if (rec.status !== "running") throw new ProblemsError(`run ${rec.id} is not running (${rec.status})`);
      if (!runs.pidAlive(rec)) {
        rec.status = "interrupted";
        runs.write(rec);
        throw new ProblemsError(`run ${rec.id}'s process is already gone`);
      }
      rec.status = "cancelled";
      runs.write(rec);
      try {
        process.kill(rec.pid, "SIGTERM");
      } catch (e) {
        throw new ProblemsError(`could not signal pid ${rec.pid}: ${e.message}`);
      }
      const deadline = Date.now() + CANCEL_GRACE_MS;
      while (Date.now() < deadline && runs.pidAlive(rec)) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (runs.pidAlive(rec)) {
        try {
          process.kill(rec.pid, "SIGKILL");
        } catch {
          /* it went away between the check and the signal */
        }
        ui.eprint(`run ${rec.id} did not stop on SIGTERM — killed`);
      } else {
        ui.eprint(`run ${rec.id} cancelled`);
      }
    });
  gh(cancel, { usage: ["<id>"], examples: [{ cmd: "ops task cancel 42" }] });
}

// KEY=VALUE (whole value or one comma-separated token) / KEY~VALUE (substring)
function matchesParam(rec, filter) {
  const partial = filter.includes("~") && (!filter.includes("=") || filter.indexOf("~") < filter.indexOf("="));
  const sep = partial ? "~" : "=";
  const at = filter.indexOf(sep);
  if (at < 1) throw new UsageError(`invalid --param filter: ${filter}`, "use KEY=VALUE or KEY~VALUE");
  const key = filter.slice(0, at).toLowerCase();
  const want = filter.slice(at + 1);
  for (const [k, v] of Object.entries(rec.params || {})) {
    if (k.toLowerCase() !== key) continue;
    if (partial) {
      if (String(v).includes(want)) return true;
    } else if (String(v) === want || String(v).split(",").map((x) => x.trim()).includes(want)) {
      return true;
    }
  }
  return false;
}

module.exports = { register, doRun, parseParams, matchesParam, duration, human, ago, cleanLog };
