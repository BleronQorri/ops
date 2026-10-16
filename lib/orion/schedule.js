"use strict";

// `ops schedule` — run a script on a timer.
//
//   add   put `ops run <script> …` on a timer
//   ls    the schedules, with their last run
//   get   one schedule, and what the scheduler was given
//   run   fire one now, without waiting for the timer
//   rm    take one off the timer
//
// The timer belongs to launchd (macOS) or cron (elsewhere); ops writes the
// agent or the crontab line and keeps a record of it. Every firing is an
// ordinary `ops run`, recorded with the schedule's name, so what it printed is
// `ops task logs <id>` and nothing about the script changes: it runs without a
// terminal, which means it asks nothing and refuses whatever needs a hand.

const os = require("os");
const ui = require("../ui");
const { c, cerr, UsageError, ProblemsError } = ui;
const cat = require("./catalogue");
const schedules = require("./schedules");
const task = require("./task");

function collect(v, acc = []) {
  acc.push(v);
  return acc;
}

function whenCell(rec) {
  return rec.every ? `every ${rec.every}` : rec.cron;
}

function requireSchedule(name) {
  const rec = schedules.read(name);
  if (!rec) throw new ProblemsError(`no schedule named ${name}`);
  return rec;
}

function lastRunCell(rec) {
  const last = schedules.lastRun(rec.name);
  if (!last) return process.stdout.isTTY ? c.faint("never") : "never";
  return `${task.statusMark(last.status)} ${task.ago(last.started_at)}`;
}

function loadedCell(rec) {
  const yes = schedules.loaded(rec);
  if (!process.stdout.isTTY) return yes ? "loaded" : "not loaded";
  return yes ? c.ok("loaded") : c.bad("not loaded");
}

function detail(rec) {
  const last = schedules.lastRun(rec.name);
  const rows = [
    ["Schedule", rec.name],
    ["Script", `${rec.script}${rec.args.length ? " " + rec.args.join(" ") : ""}`],
    ["Params", Object.entries(rec.params || {}).map(([k, v]) => `${k}=${v}`).join(" ") || c.faint("none")],
    ["When", whenCell(rec)],
    ["Timer", `${rec.backend} · ${loadedCell(rec)}`],
    ["Directory", rec.cwd],
    ["Created", `${rec.created_at}  (${task.ago(rec.created_at)}) by ${rec.created_by}`],
    ["Last run", last ? `${last.id} ${task.statusMark(last.status)} ${task.ago(last.started_at)}  · ops task get ${last.id}` : c.faint("never")],
    ["Timer log", schedules.logPath(rec.name)],
  ];
  if (rec.backend === "launchd") rows.push(["Agent", rec.installed]);
  return rows.map(([k, v]) => `  ${ui.pad(k, 11)} ${v}`).join("\n");
}

// What a run on a timer cannot do, said once, at the moment the timer is set.
function unattendedNotes(script) {
  const notes = [];
  if (script.asks) notes.push("it asks the operator (asks: true) — without a terminal it asks nothing, so every answer has to be an argument");
  if (script.tier && script.tier !== "read-only") notes.push(`its tier is ${script.tier}: a write that needs a hand is refused without a terminal, and a dry run is what you get`);
  if (script.secrets?.length) notes.push(`it reads ${script.secrets.join(", ")} from .env; an expired one is withheld and the run fails, so \`ops secrets list\` is the thing to watch`);
  return notes;
}

// The verbs, as functions: `ops schedule add`, `run` and `rm` call these, and so
// does the schedules pane of `ops interactive`, so a timer set from the screen is
// the same timer in every respect.

// Checks everything first — the two timer flags, the script, the name — so a bad
// call is refused before anything is written, then installs and says so.
function doAdd({ token, args = [], params = {}, every = null, cron = null, name = null }) {
  if (!every === !cron) throw new UsageError("give --every or --cron, one of the two", 'e.g. `--every 5h` or `--cron "0 */5 * * *"`');
  if (args[0] === "--") args = args.slice(1);
  every = every ? String(every).trim() : null;
  cron = cron ? schedules.parseCron(cron).expr : null;
  if (every) {
    schedules.everySeconds(every);
    if (schedules.backend() === "crontab") schedules.everyAsCron(schedules.everySeconds(every));
  }
  const { script } = task.resolve(token);
  name = schedules.checkName(name || script.name);
  const before = schedules.read(name);

  const rec = schedules.install({
    name,
    script: token,
    args,
    params,
    every,
    cron,
    cwd: process.cwd(),
    path: process.env.PATH || "",
    created_at: new Date().toISOString(),
    created_by: os.userInfo().username,
  });

  const tier = script.tier ? cat.paintTier(script.tier, script.tier, cerr) : "tier unknown";
  ui.eprint(`${cerr.faint("ops ▸")} ${before ? "replaced" : "scheduled"} ${cerr.bold(name)}  ${whenCell(rec)}  ${tier}  ${cerr.faint(`(${rec.backend})`)}`);
  for (const note of unattendedNotes(script)) ui.eprint(cerr.faint(`  · ${note}`));
  ui.eprint(cerr.faint(`  · ops schedule run ${name} fires it now · ops task ls --schedule ${name} shows what it did`));
  return rec;
}

function doKick(rec) {
  schedules.kick(rec);
  return `started ${rec.name} · ops task ls --schedule ${rec.name}`;
}

function doRemove(rec) {
  schedules.uninstall(rec);
  return `removed ${rec.name}`;
}

function register(program) {
  const { gh } = require("../program");

  const grp = program
    .command("schedule")
    .summary("Run a script on a timer")
    .description(
      "Put `ops run <script> …` on a timer owned by the operating system — a launchd user agent on macOS, a crontab line elsewhere — so it fires without a terminal open and comes back after a reboot. On macOS a firing missed while the machine slept runs on wake; cron skips it.\n\nEvery firing is an ordinary run: recorded, captured, and listed by `ops task ls --schedule <name>`. The script sees what it would see from `ops run` in a pipe — no terminal — so it asks nothing, takes everything it needs as arguments, and refuses whatever its own rules say needs a hand. ops adds no `--yes` and removes no prompt. Saved secrets reach it from .env the usual way; nothing secret is written into the agent or the crontab line.\n\nThe working directory, PATH and the OPS_* variables are taken from the shell that adds the schedule, so reports land where they would have and the same catalogue, config and run store are used.\n\nRecords live under $OPS_STATE_DIR (default ~/.local/state/ops/orion/schedules)."
    )
    .helpGroup("SCRIPT COMMANDS")
    .enablePositionalOptions();
  gh(grp, {
    examples: [
      { cmd: "ops schedule add --every 5h confirm_comarch_uat_queue --queue invoice" },
      { cmd: 'ops schedule add --cron "0 7 * * 1-5" check_invopop_suppliers --problems' },
      { cmd: "ops schedule ls" },
      { cmd: "ops task ls --schedule confirm_comarch_uat_queue" },
      { cmd: "ops schedule rm confirm_comarch_uat_queue" },
    ],
    learnMore: ["Read `ops help schedules` for what a run on a timer can and cannot do."],
  });

  // ---- add
  const add = grp
    .command("add")
    .summary("Put a script on a timer")
    .description(
      "Schedule `ops run <script> [<script-args>...]` with `--every <duration>` or a five-field `--cron` expression. Exactly one of the two is given. Everything after the script name is handed to the script as typed, so the arguments that replace its prompts go there; ops' own flags go before it.\n\nThe schedule is named after the script unless `--name` says otherwise, which is how the same script is scheduled twice with different arguments. Adding a name that exists replaces that schedule.\n\n`--every` is an interval from when the timer is loaded (launchd) or, on cron, a `*/n` line, which only works for an interval that divides the hour or the day evenly; give the odd ones with `--cron`.\n\nThe script is resolved and checked the way `ops run` checks it, and what it declares about itself is read back to you: a script that asks the operator asks nothing on a timer, and a write that needs a terminal is refused on one."
    )
    .argument("<script>", "script name, or <name>/<file> for a secondary entrypoint")
    .argument("[args...]", "arguments for the script")
    .option("--every <duration>", "fire this often: 30m, 5h, 1d")
    .option("--cron <expression>", 'fire on a cron schedule: "minute hour day month weekday"')
    .option("-n, --name <name>", "the schedule's name (default: the script's)")
    .option("-p, --param <KEY=VALUE>", "parameter passed to the script as an environment variable; repeatable. Must precede <script>", collect)
    .passThroughOptions()
    .allowUnknownOption()
    .allowExcessArguments()
    .action((token, args, opts) => {
      doAdd({ token, args, params: task.parseParams(opts.param || []), every: opts.every, cron: opts.cron, name: opts.name });
    });
  gh(add, {
    usage: ["[flags] {--every <duration> | --cron <expression>} <script> [<script-args>...]"],
    examples: [
      { cmd: "ops schedule add --every 5h confirm_comarch_uat_queue --queue invoice", note: "the queue is an argument because the timer cannot answer a picker" },
      { cmd: 'ops schedule add --cron "0 7 * * 1-5" check_invopop_suppliers --problems --report', note: "weekdays at 07:00, the report in the directory you ran this from" },
      { cmd: "ops schedule add --name uat_aperak --every 5h confirm_comarch_uat_queue --queue aperak", note: "the same script on a second timer" },
      { cmd: "ops schedule add -p PROVIDER_ID=1 --every 1d backfill_missing_documents --dry-run", note: "parameters go before the script name, like `ops run`" },
    ],
  });

  // ---- ls
  const ls = grp
    .command("ls")
    .summary("List the schedules and their last run")
    .description("List every schedule ops made: what it runs, how often, whether the scheduler still has it loaded, and how its last firing ended. A schedule that is not loaded was taken out from under ops — a deleted agent, an edited crontab — and `ops schedule add` with the same name puts it back.")
    .option("--json", "output JSON instead of a table")
    .action((opts) => {
      const list = schedules.all();
      if (opts.json) return process.stdout.write(ui.json(list.map((r) => ({ ...r, loaded: schedules.loaded(r), last_run: schedules.lastRun(r.name) }))));
      if (!list.length) {
        if (process.stdout.isTTY) ui.eprint(c.faint("nothing scheduled — `ops schedule add --every 5h <script> …`"));
        return;
      }
      process.stdout.write(
        ui.table(
          list.map((r) => [r.name, `${r.script}${r.args.length ? " " + r.args.join(" ") : ""}`, whenCell(r), loadedCell(r), lastRunCell(r)]),
          ["NAME", "SCRIPT", "WHEN", "TIMER", "LAST RUN"]
        )
      );
    });
  gh(ls, { usage: ["[flags]"], examples: [{ cmd: "ops schedule ls" }, { cmd: "ops schedule ls --json | jq -r '.[] | select(.loaded | not) | .name'" }] });

  // ---- get
  const get = grp
    .command("get")
    .summary("Show one schedule and what the scheduler was given")
    .description("Show everything recorded about a schedule, its last run, and — with `--rendered` — the plist or crontab line exactly as the scheduler holds it.")
    .argument("<name>", "schedule name")
    .option("--json", "output the record as JSON")
    .option("--rendered", "print the launchd plist or the crontab line instead")
    .action((name, opts) => {
      const rec = requireSchedule(name);
      if (opts.json) return process.stdout.write(ui.json({ ...rec, loaded: schedules.loaded(rec), last_run: schedules.lastRun(rec.name) }));
      if (opts.rendered) return process.stdout.write(schedules.rendered(rec));
      process.stdout.write(`${detail(rec)}\n`);
    });
  gh(get, { usage: ["<name> [flags]"], examples: [{ cmd: "ops schedule get confirm_comarch_uat_queue" }, { cmd: "ops schedule get confirm_comarch_uat_queue --rendered" }] });

  // ---- run
  const run = grp
    .command("run")
    .summary("Fire a schedule now, without waiting for the timer")
    .description("Start the scheduled command now, the way the timer would: in the background, without a terminal, recorded as a run of that schedule. On macOS this is `launchctl kickstart`; cron has no such thing, so ops starts the command itself, detached. Either way this returns at once — `ops task ls --schedule <name>` shows how it went.")
    .argument("<name>", "schedule name")
    .action((name) => {
      ui.eprint(`${cerr.faint("ops ▸")} ${doKick(requireSchedule(name))}`);
    });
  gh(run, { usage: ["<name>"], examples: [{ cmd: "ops schedule run confirm_comarch_uat_queue" }, { cmd: "ops schedule run confirm_comarch_uat_queue && sleep 5 && ops task ls --schedule confirm_comarch_uat_queue -L 1" }] });

  // ---- interactive: the one screen, opened on this pane
  const inter = grp
    .command("interactive")
    .summary("Browse the schedules on the interactive screen")
    .description("Open `ops interactive` on its SCHEDULES pane: enter shows a schedule's record, `r` fires it now, `l` opens its timer log, `x` removes it, and tab reaches the scripts (where `s` puts one on a timer) and the runs. Needs a terminal.")
    .action(async () => {
      await require("./interactive").open({ pane: "schedules" });
    });
  gh(inter, { usage: [""], examples: [{ cmd: "ops schedule interactive" }], learnMore: ["The whole screen and its keys: `ops interactive --help`."] });

  // ---- rm
  const rm = grp
    .command("rm")
    .summary("Take a schedule off the timer")
    .description("Unload the agent or drop the crontab line, and forget the schedule. The runs it started stay in `ops task ls`; a run in progress is not stopped — `ops task cancel <id>` does that.")
    .argument("<name>", "schedule name")
    .action((name) => {
      ui.eprint(`${cerr.faint("ops ▸")} ${doRemove(requireSchedule(name))}`);
    });
  gh(rm, { usage: ["<name>"], examples: [{ cmd: "ops schedule rm confirm_comarch_uat_queue" }] });

}

module.exports = { register, doAdd, doKick, doRemove, detail, whenCell, unattendedNotes };
