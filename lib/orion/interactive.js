"use strict";

// `ops interactive` — the catalogue and the run history on one screen, each pane
// carrying the verbs that belong to it: view a script or run it, read a run's
// record or its log, run it again, stop one that is still going.
//
// It is a loop of single frames (lib/screen.js). A frame erases itself before
// anything else touches the terminal, so the pager, a script's own prompts and a
// script's output all behave exactly as they do when the command is typed by
// hand, and they stay in the scrollback afterwards. Nothing is run differently
// here: `r` calls the same task.doRun() that `ops run` does — same banner, same
// capture, same recorded run, same exit code — and `x` the same task.doCancel().
//
// The session's own exit code is 0 whatever the runs did: the failures belong to
// the runs, and `ops task ls` is where they are read afterwards.

const ui = require("../ui");
const { c, UsageError, ProblemsError } = ui;
const screen = require("../screen");
const cat = require("./catalogue");
const runs = require("./runs");
const task = require("./task");
const { renderView } = require("./view");

const PANES = ["scripts", "runs"];
const TAIL = 40; // log lines shown with a run's record, as `ops task get` does

const SCRIPT_KEYS = { r: "run", d: "doc", t: "retired", "?": "help" };
const RUN_KEYS = { r: "rerun", l: "logs", x: "cancel", "?": "help" };

const scriptHint = (retired) => `↑↓ move · enter view · r run · d doc · t ${retired ? "hide" : "show"} retired · tab runs · / filter · ? keys · q quit`;
const RUN_HINT = "↑↓ move · enter record · l log · r rerun · x cancel · tab scripts · / filter · ? keys · q quit";

const HELP = `${c.header("ops interactive")}

  Two panes, ${c.bold("tab")} between them: the scripts in the catalogue, and the runs
  they have produced. Every action is the command of the same name — nothing
  here runs, cancels or renders anything differently.

  ${c.header("ANYWHERE")}
    ↑ ↓ j k     move           pgup pgdn home end   move further
    /           filter (enter keeps it, esc clears it)
    tab         the other pane
    ?           this page
    q  esc      leave

  ${c.header("SCRIPTS")}
    enter       the script's page          ${c.faint("ops orion script view <name>")}
    r           run it                     ${c.faint("ops run <name>")}
    d           its AGENTS.md, verbatim    ${c.faint("ops orion script view <name> --raw")}
    t           show retired scripts too   ${c.faint("ops orion script list --include-retired")}

  ${c.header("RUNS")}
    enter       the run's record and the tail of its log   ${c.faint("ops task get <id>")}
    l           everything it printed                      ${c.faint("ops task logs <id>")}
    r           run it again, same arguments               ${c.faint("ops task rerun <id>")}
    x           stop one that is still going               ${c.faint("ops task cancel <id>")}

  A run started here is recorded like any other and keeps its own exit code;
  this session always exits 0.
`;

// --- the scripts pane --------------------------------------------------------

function scriptGroups(catalogue, includeRetired) {
  const pool = catalogue.scripts.filter((s) => includeRetired || !s.hidden);
  return (filter) => {
    const f = filter.toLowerCase();
    const matching = pool.filter((s) => !f || s.name.toLowerCase().includes(f) || s.summary.toLowerCase().includes(f));
    return cat.ENVS.map((env) => {
      const items = matching
        .filter((s) => s.env === env)
        .sort((a, b) => a.access.localeCompare(b.access) || a.name.localeCompare(b.name))
        .map((s) => ({ value: s, render: () => scriptRow(s) }));
      return { heading: env.toUpperCase(), note: `${items.length} script${items.length === 1 ? "" : "s"}`, items };
    });
  };
}

function scriptRow(s) {
  const status = s.legacy ? "unannotated" : s.status;
  return (
    `${ui.pad(s.name, 32)} ${cat.paintTier(ui.pad(s.tier ?? "?", 22), s.tier, c)} ` +
    `${status === "active" ? "" : c.warn(`${status.toUpperCase()} `)}${s.summary}`
  );
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

// --- the loop ----------------------------------------------------------------

async function open() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new UsageError("interactive needs a terminal on stdin and stdout", "use `ops orion script list` and `ops task ls` when piping");
  }

  let pane = "scripts";
  let retired = false;
  const state = { scripts: { filter: "", cursor: 0 }, runs: { filter: "", cursor: 0 } };

  for (;;) {
    // Both sources are read once per frame, never per keystroke: a run started or
    // cancelled in this session, or a script edited in another window, is picked
    // up the next time the frame is drawn.
    const here = state[pane];
    let res;
    if (pane === "scripts") {
      const catalogue = cat.loadCatalogue();
      const errors = catalogue.problems.filter((p) => p.level === "error").length;
      res = await screen.select({
        title: "ops ▸ scripts",
        hint: scriptHint(retired),
        mode: "slash",
        keys: SCRIPT_KEYS,
        groups: scriptGroups(catalogue, retired),
        empty: "no script matches",
        footer: errors ? `${errors} catalogue problem(s) — ops orion docs check` : null,
        ...here,
      });
      if (!res) return 0;
      state.scripts = { filter: res.filter, cursor: res.cursor };
      if (!(await onScript(res, catalogue, () => (retired = !retired)))) continue;
    } else {
      res = await screen.select({
        title: "ops ▸ runs",
        hint: RUN_HINT,
        mode: "slash",
        keys: RUN_KEYS,
        groups: runGroups(runs.all()),
        empty: "nothing has been run yet — tab to the scripts and press r",
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
    case "default":
      if (s) ui.pager(renderView(s, catalogue.root));
      return false;
    case "doc":
      if (s) ui.pager(s.raw);
      return false;
    case "run":
      if (s) await runScript(s.name);
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
    .summary("Browse the scripts and the runs on one screen, and act on them")
    .description("Open the catalogue and the run history as two panes of one screen: view a script's page or run it, read a run's record or its log, run it again, or stop one that is still going.\n\nEvery key is the command of the same name — `r` on a script is `ops run <name>`, `r` on a run is `ops task rerun <id>` — so a run started here gets the same banner, the same recorded id and the same captured log as one typed by hand, and the script sees the same terminal. The screen erases itself while a script or a pager has the terminal, and draws again afterwards.\n\nThe session exits 0 whatever the runs did; a run keeps its own exit code in its record.\n\nNeeds a terminal on stdin and stdout. Set `interactive.bare` to open it for a bare `ops` as well.")
    .helpGroup("SCRIPT COMMANDS")
    .action(async () => {
      await open();
    });
  gh(cmd, {
    usage: [""],
    examples: [
      { cmd: "ops interactive" },
      { cmd: "ops config set interactive.bare true", note: "then a bare `ops` on a terminal opens it instead of the short help" },
    ],
    learnMore: ["The same things one at a time: `ops orion script list`, `ops orion script pick`, `ops task ls`."],
  });
}

module.exports = { register, open, scriptGroups, scriptRow };
