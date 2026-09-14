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

// Enter is the verb in both panes: it runs a script, and it opens a run's record.
const SCRIPT_KEYS = { v: "view", d: "doc", t: "retired", "?": "help" };
const RUN_KEYS = { r: "rerun", l: "logs", x: "cancel", "?": "help" };

const scriptHint = (retired) => `↑↓ move · enter run · v view · d doc · t ${retired ? "hide" : "show"} retired · tab runs · / filter · ? keys · q quit`;
const RUN_HINT = "↑↓ move · enter record · l log · r rerun · x cancel · tab scripts · / filter · ? keys · q quit";
const runFooter = (r) =>
  r ? c.faint("enter shows run ") + c.cmd(`ops task get ${r.id}`) + c.faint("  ·  l log · r rerun · x cancel") : null;

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
    enter       run it                     ${c.faint("ops run <name>")}
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

  A run started here is recorded like any other and keeps its own exit code;
  this session always exits 0.
`;

// --- the scripts pane --------------------------------------------------------

// The filter reaches the country, the integration and the integrator too, so
// typing "zatca" or "SA" narrows the screen to one tax authority's tools.
function haystack(s) {
  return [s.name, s.summary, s.domain, s.country, s.integration, s.integrator].filter(Boolean).join(" ").toLowerCase();
}

const NAME_MAX = 34;

function statusOf(s) {
  return s.legacy ? "unannotated" : s.status;
}

// Columns are measured against the rows actually on screen, not against every
// script that could ever exist: with nothing staging in sight the tier column is
// as wide as "prod-write", and a screen where nothing declares a country has no
// country column at all rather than a gutter of blanks.
function measure(scripts) {
  const widest = (f) => scripts.reduce((n, s) => Math.max(n, ui.displayWidth(f(s))), 0);
  return {
    name: Math.min(NAME_MAX, widest((s) => s.name)),
    country: widest((s) => s.country || ""),
    integration: widest((s) => s.integration || ""),
    tier: widest((s) => s.tier || "?"),
    status: widest((s) => (statusOf(s) === "active" ? "" : statusOf(s).toUpperCase())),
  };
}

function scriptGroups(catalogue, includeRetired) {
  const pool = catalogue.scripts.filter((s) => includeRetired || !s.hidden);
  return (filter) => {
    const f = filter.toLowerCase();
    const matching = pool.filter((s) => !f || haystack(s).includes(f));
    const cols = measure(matching);
    const groups = [];
    // The domain is named once, and the environments sit under it.
    for (const domain of cat.domainOrder(matching)) {
      const inDomain = matching.filter((s) => cat.domainOf(s) === domain);
      if (!inDomain.length) continue;
      for (const env of cat.ENVS) {
        const items = inDomain
          .filter((s) => s.env === env)
          .sort((a, b) => a.access.localeCompare(b.access) || a.name.localeCompare(b.name))
          .map((s) => ({ value: s, render: () => scriptRow(s, cols) }));
        if (!items.length) continue;
        groups.push({
          section: cat.domainLabel(domain).toUpperCase(),
          sectionNote: `${inDomain.length} script${inDomain.length === 1 ? "" : "s"}`,
          heading: env,
          note: `${items.length}`,
          items,
        });
      }
    }
    return groups;
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
  if (cols.integration) parts.push(c.sql(ui.pad(s.integration || "", cols.integration)));
  parts.push(cat.paintTier(ui.pad(s.tier ?? "?", cols.tier), s.tier, c));
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
      // What r would do to the highlighted row, in the words of the command it
      // calls — including when the answer is that there is nothing to run.
      const footer = (s) => {
        if (!s) return errors ? c.warn(`${errors} catalogue problem(s) — ops orion docs check`) : null;
        if (s.docOnly) return c.faint(`${s.status} · nothing to run — `) + c.cmd("v") + c.faint(" reads it");
        if (s.retired) return c.faint("retired · ") + c.cmd("v") + c.faint(" reads why; ops run refuses it");
        const line = c.faint("enter runs  ") + c.cmd(`ops run ${s.name}`) + c.faint("  ·  v reads the page");
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
    case "default":
      if (s) await runScript(s.name);
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
