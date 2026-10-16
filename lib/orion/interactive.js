"use strict";

// `ops interactive` — the catalogue, the run history and the timers on one
// screen, each pane carrying the verbs that belong to it: view a script, run it
// or put it on a timer; read a run's record or its log, run it again, stop one
// that is still going; fire a timer now or take it away.
//
// It is a loop of single frames (lib/screen.js). A frame erases itself before
// anything else touches the terminal, so the pager, a script's own prompts and a
// script's output all behave exactly as they do when the command is typed by
// hand, and they stay in the scrollback afterwards. Nothing is run differently
// here: `r` calls the same task.doRun() that `ops run` does — same banner, same
// capture, same recorded run, same exit code — `x` the same task.doCancel(), and
// `s` the same schedule.doAdd() that `ops schedule add` does.
//
// The session's own exit code is 0 whatever the runs did: the failures belong to
// the runs, and `ops task ls` is where they are read afterwards.

const readline = require("readline");
const ui = require("../ui");
const { c, UsageError, ProblemsError } = ui;
const screen = require("../screen");
const cat = require("./catalogue");
const runs = require("./runs");
const task = require("./task");
const schedules = require("./schedules");
const schedule = require("./schedule");
const { renderView } = require("./view");

const PANES = ["scripts", "runs", "schedules"];
const TAIL = 40; // log lines shown with a run's record, as `ops task get` does

// Enter is the verb in both panes: it runs a script, and it opens a run's record.
const SCRIPT_KEYS = { v: "view", d: "doc", s: "schedule", t: "retired", "?": "help" };
const RUN_KEYS = { r: "rerun", l: "logs", x: "cancel", "?": "help" };
const SCHEDULE_KEYS = { r: "fire", l: "timerlog", x: "remove", "?": "help" };

const scriptHint = (retired) => `↑↓ move · enter run · s schedule · v view · d doc · t ${retired ? "hide" : "show"} retired · tab runs · / filter · ? keys · q quit`;
const RUN_HINT = "↑↓ move · enter record · l log · r rerun · x cancel · tab schedules · / filter · ? keys · q quit";
const SCHEDULE_HINT = "↑↓ move · enter record · r fire now · l timer log · x remove · tab scripts · / filter · ? keys · q quit";
const runFooter = (r) =>
  r ? c.faint("enter shows run ") + c.cmd(`ops task get ${r.id}`) + c.faint("  ·  l log · r rerun · x cancel") : null;
const scheduleFooter = (s) =>
  s ? c.faint("enter shows ") + c.cmd(`ops schedule get ${s.name}`) + c.faint("  ·  r fires it now · x removes it · its runs are under tab") : null;

const HELP = `${c.header("ops interactive")}

  Three panes, ${c.bold("tab")} between them: the scripts in the catalogue, the runs
  they have produced, and the timers they are on. Every action is the command of
  the same name — nothing here runs, cancels or renders anything differently.

  ${c.header("ANYWHERE")}
    ↑ ↓ j k     move           pgup pgdn home end   move further
    /           filter (enter keeps it, esc clears it)
    tab         the other pane
    ?           this page
    q  esc      leave

  ${c.header("SCRIPTS")}
    enter       run it, asking for its arguments first   ${c.faint("ops run <name> …")}
    s           put it on a timer: its arguments, then how often   ${c.faint("ops schedule add …")}
    v           the script's page          ${c.faint("ops orion script view <name>")}
    d           its AGENTS.md, verbatim    ${c.faint("ops orion script view <name> --raw")}
    t           show retired scripts too   ${c.faint("ops orion script list --include-retired")}

    A runbook and a retired script have nothing to run: enter says so and v
    reads them. Everything else starts exactly as ${c.faint("ops run <name>")} would, gates
    and all — a production write is announced in red before it begins.

  ${c.header("RUNS")}
    enter       the run's record and the tail of its log   ${c.faint("ops task get <id>")}
    l           everything it printed                      ${c.faint("ops task logs <id>")}
    r           run it again, same arguments               ${c.faint("ops task rerun <id>")}
    x           stop one that is still going               ${c.faint("ops task cancel <id>")}

  ${c.header("SCHEDULES")}
    enter       the schedule's record                      ${c.faint("ops schedule get <name>")}
    r           fire it now, without waiting               ${c.faint("ops schedule run <name>")}
    l           the timer's own log                        ${c.faint("ops schedule get <name>")}
    x           take it off the timer                      ${c.faint("ops schedule rm <name>")}

  A timer runs the script without a terminal, so it asks nothing: the arguments
  picked under s are everything it gets. Its firings are runs like any other
  and sit in the RUNS pane; ${c.faint("ops help schedules")} has the rest.

  A run started here is recorded like any other and keeps its own exit code;
  this session always exits 0.
`;

// --- the scripts pane --------------------------------------------------------

// The filter reaches the country, the integration and the integrator too, so
// typing "zatca" or "SA" narrows the screen to one tax authority's tools — and
// because those are the headings now, a filter that matches one leaves a screen
// of exactly that subsection.
function haystack(s) {
  return [s.name, s.summary, s.domain, s.country, s.integration, s.integrator, s.kind === "runbook" && "runbook"].filter(Boolean).join(" ").toLowerCase();
}

const NAME_MAX = 34;

function statusOf(s) {
  return cat.statusLabel(s);
}

// production and staging, short enough to sit in a column.
const envShort = (env) => (env === "staging" ? "stg" : "prod");

// Columns are measured against the rows actually on screen, not against every
// script that could ever exist: with nothing staging in sight the tier column is
// as wide as "prod-write", and a screen where nothing declares a country has no
// country column at all rather than a gutter of blanks. A column every heading
// has already answered is not a column either — the integration is now a heading
// on every screen, and the country and the integrator are whenever the scripts
// under one heading agree on them.
function measure(groups) {
  const scripts = groups.flatMap((g) => g.items);
  const widest = (f, rows = scripts) => rows.reduce((n, s) => Math.max(n, ui.displayWidth(f(s))), 0);
  // The rows whose own heading has not already answered for this field. Measuring
  // over those alone means a field every heading covers, and a field only covered
  // headings had a value for, both come out zero — and a zero column is not drawn.
  const uncovered = (field) => groups.filter((g) => !g.group.covers.includes(field)).flatMap((g) => g.items);
  return {
    name: Math.min(NAME_MAX, widest((s) => s.name)),
    country: widest((s) => s.country || "", uncovered("country")),
    integrator: widest((s) => s.integrator || "", uncovered("integrator")),
    tier: widest((s) => s.tier || "?"),
    // The environment lost its heading to the integration, so it comes back as a
    // column — but only once the rows on screen actually mix the two. A screen of
    // production scripts does not need a column saying so eleven times.
    env: new Set(scripts.map((s) => s.env)).size > 1 ? widest((s) => envShort(s.env)) : 0,
    status: widest((s) => (statusOf(s) === "active" ? "" : statusOf(s).toUpperCase())),
  };
}

function scriptGroups(catalogue, includeRetired) {
  const pool = catalogue.scripts.filter((s) => includeRetired || !s.hidden);
  return (filter) => {
    const f = filter.toLowerCase();
    const matching = pool.filter((s) => !f || haystack(s).includes(f));
    // The domain is named once and the integrations sit under it: which scheme a
    // tool talks to is what people come to this screen knowing, and one heading
    // per scheme puts the three ZATCA tools together instead of scattering them
    // down a column. The groups are built before the rows are measured, because a
    // heading that names the country settles that column for its rows.
    const groups = [];
    for (const domain of cat.domainOrder(matching)) {
      const inDomain = matching.filter((s) => cat.domainOf(s) === domain);
      if (!inDomain.length) continue;
      for (const { group, items } of cat.integrationGroups(inDomain)) groups.push({ domain, inDomain, group, items });
    }
    const cols = measure(groups);
    return groups.map((g) => ({
      section: cat.domainLabel(g.domain).toUpperCase(),
      sectionNote: `${g.inDomain.length} script${g.inDomain.length === 1 ? "" : "s"}`,
      heading: g.group.label,
      note: `${g.items.length}`,
      items: g.items.map((s) => ({ value: s, render: () => scriptRow(s, cols) })),
    }));
  };
}

// One row. Columns are padded to what the rows on screen need and no more, an
// empty one is skipped rather than padded, and the gap between them is wide
// enough to read as a gap.
const GAP = "   ";

function scriptRow(s, cols) {
  const status = statusOf(s);
  const parts = [ui.pad(ui.clip(s.name, cols.name), cols.name)];
  if (cols.country) parts.push(ui.pad(s.country || "", cols.country));
  if (cols.integrator) parts.push(c.sql(ui.pad(s.integrator || "", cols.integrator)));
  parts.push(cat.paintTier(ui.pad(s.tier ?? "?", cols.tier), s.tier, c));
  // The environment is the one thing worth knowing before enter, so it is never
  // faint: production red and staging warn, the same two colours the tiers use
  // for the same two worlds.
  if (cols.env) {
    const paint = s.env === "staging" ? c.warn : c.bad;
    parts.push(paint(ui.pad(envShort(s.env), cols.env)));
  }
  if (cols.status) parts.push(c.warn(ui.pad(status === "active" ? "" : status.toUpperCase(), cols.status)));
  parts.push(s.summary);
  return parts.join(GAP);
}

// --- the runs pane -----------------------------------------------------------

function runGroups(list) {
  return (filter) => {
    const f = filter.toLowerCase();
    const items = list
      .filter((r) => !f || String(r.id) === f || (r.script || "").toLowerCase().includes(f) || r.status.includes(f) || task.argsCell(r).toLowerCase().includes(f))
      .map((r) => ({ value: r, render: () => runRow(r) }));
    return [{ items }];
  };
}

function runRow(r) {
  return (
    `${ui.padTo(String(r.id), 4, true)}  ${ui.pad(task.statusMark(r.status), 11)} ${ui.pad(task.scriptCell(r), 30)} ` +
    `${ui.pad(task.ago(r.started_at), 11)} ${ui.pad(task.human(r.duration_ms), 8)} ${c.faint(task.argsCell(r))}`
  );
}

// --- the schedules pane ------------------------------------------------------

function scheduleGroups(list) {
  return (filter) => {
    const f = filter.toLowerCase();
    const items = list
      .filter((s) => !f || s.name.toLowerCase().includes(f) || s.script.toLowerCase().includes(f) || s.args.join(" ").toLowerCase().includes(f))
      .map((s) => ({ value: s, render: () => scheduleRow(s) }));
    return [{ items }];
  };
}

function scheduleRow(s) {
  const loaded = schedules.loaded(s);
  const last = schedules.lastRun(s.name);
  return (
    `${ui.pad(ui.clip(s.name, 28), 28)}  ${ui.pad(schedule.whenCell(s), 16)} ${ui.pad(loaded ? c.ok("loaded") : c.bad("not loaded"), 10)} ` +
    `${ui.pad(last ? `${task.statusMark(last.status)} ${task.ago(last.started_at)}` : c.faint("never"), 24)} ${c.faint(`${s.script} ${s.args.join(" ")}`)}`
  );
}

// --- the loop ----------------------------------------------------------------

// The same screen whichever pane it opens on: `ops interactive` starts on the
// scripts, `ops schedule interactive` on the schedules, and tab reaches the rest.
async function open({ pane: start = "scripts" } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new UsageError("interactive needs a terminal on stdin and stdout", "use `ops orion script list`, `ops task ls` and `ops schedule ls` when piping");
  }

  let pane = PANES.includes(start) ? start : "scripts";
  let retired = false;
  const state = { scripts: { filter: "", cursor: 0 }, runs: { filter: "", cursor: 0 }, schedules: { filter: "", cursor: 0 } };

  for (;;) {
    // Both sources are read once per frame, never per keystroke: a run started or
    // cancelled in this session, or a script edited in another window, is picked
    // up the next time the frame is drawn.
    const here = state[pane];
    let res;
    if (pane === "scripts") {
      const catalogue = cat.loadCatalogue();
      const errors = catalogue.problems.filter((p) => p.level === "error").length;
      // What r would do to the highlighted row, in the words of the command it
      // calls — including when the answer is that there is nothing to run.
      const footer = (s) => {
        if (!s) return errors ? c.warn(`${errors} catalogue problem(s) — ops orion docs check`) : null;
        if (s.docOnly) return c.faint(`${s.status} · nothing to run — `) + c.cmd("v") + c.faint(" reads it");
        if (s.retired) return c.faint("retired · ") + c.cmd("v") + c.faint(" reads why; ops run refuses it");
        const line = c.faint("enter runs  ") + c.cmd(`ops run ${s.name}`) + c.faint(s.asks ? "  ·  the script asks what it needs  ·  v reads the page" : "  ·  asks for arguments first  ·  v reads the page");
        return cat.isProdWrite(s.tier) ? `${c.bad("⚠ PRODUCTION WRITE")}  ${line}` : line;
      };
      res = await screen.select({
        title: "ops ▸ scripts",
        hint: scriptHint(retired),
        mode: "slash",
        keys: SCRIPT_KEYS,
        groups: scriptGroups(catalogue, retired),
        empty: "no script matches",
        footer,
        ...here,
      });
      if (!res) return 0;
      state.scripts = { filter: res.filter, cursor: res.cursor };
      if (!(await onScript(res, catalogue, () => (retired = !retired)))) continue;
    } else if (pane === "schedules") {
      res = await screen.select({
        title: "ops ▸ schedules",
        hint: SCHEDULE_HINT,
        mode: "slash",
        keys: SCHEDULE_KEYS,
        groups: scheduleGroups(schedules.all()),
        footer: scheduleFooter,
        empty: "nothing on a timer — tab to the scripts and press s",
        ...here,
      });
      if (!res) return 0;
      state.schedules = { filter: res.filter, cursor: res.cursor };
      if (!(await onSchedule(res))) continue;
    } else {
      res = await screen.select({
        title: "ops ▸ runs",
        hint: RUN_HINT,
        mode: "slash",
        keys: RUN_KEYS,
        groups: runGroups(runs.all()),
        footer: runFooter,
        empty: "nothing has been run yet — tab to the scripts and press enter",
        ...here,
      });
      if (!res) return 0;
      state.runs = { filter: res.filter, cursor: res.cursor };
      if (!(await onRun(res))) continue;
    }
    if (res.action === "tab") pane = PANES[(PANES.indexOf(pane) + 1) % PANES.length];
  }
}

// Each handler returns false when the frame simply redraws, so the loop can tell
// a pane switch from an action that already did its work.
async function onScript(res, catalogue, toggleRetired) {
  const s = res.value;
  switch (res.action) {
    case "help":
      ui.pager(HELP);
      return false;
    case "retired":
      toggleRetired();
      return false;
    case "tab":
      return true;
    case "default": {
      // Esc on the arguments frame means "I did not mean to run this", so it
      // returns to the list rather than running the script bare.
      if (s) {
        const args = await askArgs(s);
        if (args) await runScript(s.name, args);
      }
      return false;
    }
    case "schedule":
      if (s && !s.docOnly && !s.retired) await scheduleScript(s);
      else if (s) await report(c.warn(`${s.name} has nothing to run, so nothing to put on a timer`));
      return false;
    case "view":
      if (s) ui.pager(renderView(s, catalogue.root));
      return false;
    case "doc":
      if (s) ui.pager(s.raw);
      return false;
    default:
      return false;
  }
}

async function onRun(res) {
  const rec = res.value;
  switch (res.action) {
    case "help":
      ui.pager(HELP);
      return false;
    case "tab":
      return true;
    case "default":
      if (rec) ui.pager(record(rec));
      return false;
    case "logs":
      if (rec) {
        const text = task.readLog(rec);
        if (text === null) await report(c.warn(rec.captured === "none" ? `run ${rec.id} has no captured log (captured: none)` : `run ${rec.id}'s log file is gone`));
        else ui.pager(task.cleanLog(text));
      }
      return false;
    case "rerun":
      if (rec) await runScript(rec.script, rec.args || [], rec.params || {}, rec.id);
      return false;
    case "cancel":
      if (rec) await cancel(rec);
      return false;
    default:
      return false;
  }
}

async function onSchedule(res) {
  const rec = res.value;
  switch (res.action) {
    case "help":
      ui.pager(HELP);
      return false;
    case "tab":
      return true;
    case "default":
      if (rec) ui.pager(`${schedule.detail(rec)}\n`);
      return false;
    case "fire":
      if (rec) await report(schedule.doKick(rec));
      return false;
    case "timerlog":
      if (rec) {
        let text = null;
        try {
          text = require("fs").readFileSync(schedules.logPath(rec.name), "utf8");
        } catch {
          /* nothing written yet */
        }
        if (text === null || !text.trim()) await report(c.warn(`${rec.name} has no timer log yet — it has not fired`));
        else ui.pager(text);
      }
      return false;
    case "remove":
      if (rec) await report(schedule.doRemove(rec));
      return false;
    default:
      return false;
  }
}

// Split a typed line the way a shell splits quotes, and nothing else: no
// globbing, no variables, no word splitting inside quotes. What you type is what
// the script is handed, which is the whole promise of `ops run`.
function splitArgs(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(line)))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Most scripts need something to run on — tracker ids, a receipt number, a
// provider id — so enter asks for it rather than running the script bare and
// letting it fail on a missing argument.
//
// The script's own examples already say what good input looks like, so they are a
// frame like every other: the cursor moves with ↑↓ and jk, enter runs the
// highlighted one, esc goes back. Two rows are always there — "no arguments", and
// "type them", which is the only thing that takes the terminal and it does so
// between frames, never underneath one.
// A script with `asks: true` in its frontmatter asks the operator itself, so it runs bare.
const TYPE_ARGS = Symbol("type");
const NO_ARGS = Symbol("none");

function argGroups(script) {
  const examples = (script.examples || [])
    .map((e) => ({ args: String(e.args || "").trim(), note: String(e.note || "").trim() }))
    .filter((e) => e.args);
  const width = Math.max(0, ...examples.map((e) => e.args.length));
  return (filter) => {
    const f = filter.trim().toLowerCase();
    const items = examples
      .filter((e) => !f || `${e.args} ${e.note}`.toLowerCase().includes(f))
      .map((e) => ({
        value: e.args,
        render: (w) => ui.clip(`${ui.c.cmd(e.args.padEnd(width))}${e.note ? `  ${ui.c.faint(`· ${e.note}`)}` : ""}`, w),
      }));
    const bare = [
      { value: NO_ARGS, render: (w) => ui.clip(ui.c.faint("no arguments"), w) },
      { value: TYPE_ARGS, render: (w) => ui.clip(ui.c.faint("type them…"), w) },
    ].filter(() => !f);
    return [
      { heading: examples.length ? "examples" : null, items },
      { items: bare },
    ].filter((g) => g.items.length);
  };
}

async function askArgs(script, { forTimer = false } = {}) {
  if (!process.stdin.isTTY) return [];
  // A script that asks the operator itself runs bare — unless it is going on a
  // timer, where there is nobody to ask and the arguments are all it gets.
  if (script.asks && !forTimer) return [];
  const res = await screen.select({
    title: `ops ▸ ${script.name}`,
    hint: forTimer ? "arguments the timer will pass — enter picks · esc back" : "arguments — enter runs it · esc back",
    mode: "slash",
    groups: argGroups(script),
    empty: "no example matches",
    footer: (v) => (v === TYPE_ARGS ? ui.c.faint("enter opens a prompt") : v === NO_ARGS || !v ? ui.c.faint("runs the script bare") : ui.c.faint(`ops run ${script.name} ${v}`)),
  });
  if (!res) return null; // esc: back to the list without running anything
  if (res.value === NO_ARGS || res.value === null) return [];
  if (res.value !== TYPE_ARGS) return splitArgs(res.value);
  return splitArgs(await typeArgs(script));
}

// The one place a line is still typed, and it happens after the frame has erased
// itself — the same readline prompt this screen used to be.
async function typeArgs(script) {
  const example = (script.examples || []).map((e) => String(e.args || "").trim()).find(Boolean);
  return typeLine(`${ui.cerr.bold(script.name)} ${ui.cerr.faint(`arguments — Enter for none${example ? ` · e.g. ${example}` : ""}`)}`);
}

async function typeLine(label) {
  ui.eprint(`${ui.cerr.faint("ops ▸")} ${label}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise((res) => rl.question("  > ", res));
  } finally {
    rl.close();
  }
}

// `s` on a script: its arguments first (a timer cannot answer a picker, so even a
// script that asks gets the examples frame), then how often, then the same
// doAdd() that `ops schedule add` calls. Esc on either frame puts nothing on a
// timer.
const EVERY_CHOICES = ["30m", "1h", "2h", "5h", "6h", "12h", "1d"];
const TYPE_CRON = Symbol("cron");

async function scheduleScript(script) {
  const args = await askArgs(script, { forTimer: true });
  if (!args) return;
  const existing = schedules.read(script.name);
  const line = (when) => `ops schedule add ${when} ${script.name}${args.length ? " " + args.join(" ") : ""}`;
  const res = await screen.select({
    title: `ops ▸ ${script.name} — how often?`,
    hint: "enter sets the timer · esc back",
    mode: "slash",
    groups: () => [
      { heading: "every", items: EVERY_CHOICES.map((e) => ({ value: e, render: (w) => ui.clip(ui.c.cmd(e), w) })) },
      { items: [{ value: TYPE_CRON, render: (w) => ui.clip(ui.c.faint("type a cron expression…"), w) }] },
    ],
    footer: (v) => {
      const cmd = v === TYPE_CRON ? line('--cron "…"') : v ? line(`--every ${v}`) : "";
      const replace = existing ? `  ${ui.c.warn(`replaces the ${existing.name} timer (${schedule.whenCell(existing)})`)}` : "";
      return cmd ? ui.c.faint(cmd) + replace : null;
    },
  });
  if (!res || res.value === null) return;
  let every = null;
  let cron = null;
  if (res.value === TYPE_CRON) {
    cron = (await typeLine(`${ui.cerr.bold(script.name)} ${ui.cerr.faint('cron expression — e.g. 0 7 * * 1-5 · Enter for none')}`)).trim();
    if (!cron) return;
  } else every = res.value;
  try {
    schedule.doAdd({ token: script.name, args, every, cron });
  } catch (err) {
    if (!(err instanceof UsageError) && !(err instanceof ProblemsError)) throw err;
    ui.eprint(`${ui.cerr.bad("error:")} ${err.message}`);
    if (err.hint) ui.eprint(err.hint);
  }
  await screen.pause("↵ back to ops");
}

// A run from here is `ops run` in every respect; the pause is so its output can
// be read before the next frame draws under it.
async function runScript(token, args = [], params = {}, rerunOf = null) {
  try {
    await task.doRun({ token, args, params, log: true, rerunOf });
  } catch (err) {
    if (!(err instanceof UsageError) && !(err instanceof ProblemsError)) throw err;
    ui.eprint(`${ui.cerr.bad("error:")} ${err.message}`);
    if (err.hint) ui.eprint(err.hint);
  }
  await screen.pause("↵ back to ops");
}

async function cancel(rec) {
  try {
    await report(await task.doCancel(rec));
  } catch (err) {
    if (!(err instanceof ProblemsError)) throw err;
    await report(c.warn(err.message));
  }
}

async function report(line) {
  process.stdout.write(`  ${line}\n`);
  await screen.pause("↵ back to ops");
}

function record(rec) {
  let out = `${task.detail(rec)}\n`;
  const text = task.readLog(rec);
  if (text) {
    const lines = task.cleanLog(text).replace(/\n+$/, "").split("\n");
    const shown = lines.slice(-TAIL);
    out += `\n${ui.section(`LOG  ${c.faint(`(last ${shown.length} of ${lines.length} lines — l for all of it)`)}`, shown.map((l) => `  ${l}`).join("\n"))}\n`;
  }
  return out;
}

function register(program) {
  const { gh } = require("../program");
  const cmd = program
    .command("interactive")
    .summary("Browse the scripts, the runs and the timers on one screen, and act on them")
    .description("Open the catalogue, the run history and the schedules as three panes of one screen: view a script's page, run it or put it on a timer; read a run's record or its log, run it again, or stop one that is still going; fire a timer now or take it away.\n\nEvery key is the command of the same name — `r` on a script is `ops run <name>`, `r` on a run is `ops task rerun <id>`, `s` on a script is `ops schedule add` — so a run started here gets the same banner, the same recorded id and the same captured log as one typed by hand, and the script sees the same terminal. The screen erases itself while a script or a pager has the terminal, and draws again afterwards.\n\nThe session exits 0 whatever the runs did; a run keeps its own exit code in its record.\n\nNeeds a terminal on stdin and stdout. A bare `ops` on a terminal opens it too; set `interactive.bare` to false to get the short help there instead.")
    .helpGroup("SCRIPT COMMANDS")
    .action(async () => {
      await open();
    });
  gh(cmd, {
    usage: [""],
    examples: [
      { cmd: "ops interactive" },
      { cmd: "ops config set interactive.bare false", note: "then a bare `ops` on a terminal prints the short help instead of opening it" },
    ],
    learnMore: ["The same things one at a time: `ops orion script list`, `ops orion script pick`, `ops task ls`, `ops schedule ls`."],
  });
}

module.exports = { register, open, scriptGroups, scriptRow };
