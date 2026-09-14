"use strict";

// `ops orion script pick` — one frame of the scripts screen: type to filter,
// ↑/↓ or j/k move, Enter views, r runs, q / Esc / Ctrl-C quits. It picks one
// thing and leaves; `ops interactive` is the same list as a place to stay, with
// the runs beside it.

const ui = require("../ui");
const { UsageError } = ui;
const screen = require("../screen");
const cat = require("./catalogue");
const { scriptGroups } = require("./interactive");

function register(script) {
  const { gh } = require("../program");
  const cmd = script
    .command("pick")
    .summary("Interactive picker: arrow keys, Enter to view, r to run (TTY only)")
    .description("Browse the catalogue interactively and pick one script. Type to filter by name or summary; ↑/↓ (or j/k) move; Enter opens the script's page; r runs it; q quits.\n\nIt ends as soon as it has picked something. `ops interactive` keeps the screen open and adds the run history.")
    .action(async () => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new UsageError("pick needs a terminal on stdin and stdout", "use `ops orion script list` when piping");
      const catalogue = cat.loadCatalogue();
      const choice = await screen.select({
        title: "ops orion script pick",
        hint: "type to filter · ↑↓ move · Enter view · r run · q quit",
        mode: "type",
        keys: { r: "run" },
        groups: scriptGroups(catalogue, false),
      });
      if (!choice || !choice.value) return;
      const { renderView } = require("./view");
      const task = require("./task");
      if (choice.action === "default") {
        ui.pager(renderView(choice.value, catalogue.root));
      } else if (choice.action === "run") {
        process.exitCode = await task.doRun({ token: choice.value.name, args: [], params: {}, log: true });
      }
    });
  gh(cmd, { usage: [""], examples: [{ cmd: "ops orion script pick" }], learnMore: ["To stay on the screen and see the runs too: `ops interactive`."] });
}

module.exports = { register };
