"use strict";

// `ops orion script pick` — a small raw-mode picker. ↑/↓ or j/k move, type to
// filter, Enter views, r runs, q / Esc / Ctrl-C quits.

const readline = require("readline");
const ui = require("../ui");
const { c, UsageError } = ui;
const cat = require("./catalogue");

function register(script) {
  const { gh } = require("../program");
  const cmd = script
    .command("pick")
    .summary("Interactive picker: arrow keys, Enter to view, r to run (TTY only)")
    .description("Browse the catalogue interactively. Type to filter by name, alias or summary; ↑/↓ (or j/k) move; Enter opens the script's page; r runs it; q quits.")
    .action(async () => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new UsageError("pick needs a terminal on stdin and stdout", "use `ops orion script list` when piping");
      const catalogue = cat.loadCatalogue();
      const choice = await pick(catalogue.scripts.filter((s) => !s.hidden));
      if (!choice) return;
      const { renderView } = require("./view");
      const task = require("./task");
      if (choice.action === "view") {
        ui.pager(renderView(choice.script, catalogue.root));
      } else if (choice.action === "run") {
        process.exitCode = await task.doRun({ token: choice.script.name, args: [], params: {}, log: true });
      }
    });
  gh(cmd, { usage: [""], examples: [{ cmd: "ops orion script pick" }] });
}

function pick(scripts) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    let filter = "";
    let cursor = 0;
    let drawn = 0;

    // The rows the cursor can land on, and the headings it cannot: production and
    // staging are separate worlds, so the list says so.
    const matching = () => {
      const f = filter.toLowerCase();
      return scripts.filter((s) => !f || s.name.includes(f) || s.summary.toLowerCase().includes(f));
    };

    const items = () => {
      const rows = [];
      for (const env of cat.ENVS) {
        const group = matching().filter((s) => s.env === env);
        if (!group.length) continue;
        group.sort((a, b) => a.access.localeCompare(b.access) || a.name.localeCompare(b.name));
        rows.push({ heading: env.toUpperCase(), count: group.length });
        for (const s of group) rows.push({ script: s });
      }
      return rows;
    };

    const visible = () => items().filter((r) => r.script).map((r) => r.script);

    const draw = () => {
      if (drawn) stdout.write(`\x1b[${drawn}A\x1b[J`);
      const rows = items();
      const pickable = rows.filter((r) => r.script).length;
      cursor = Math.min(cursor, Math.max(0, pickable - 1));
      const lines = [`${c.header("ops orion script pick")}  ${c.faint("type to filter · ↑↓ move · Enter view · r run · q quit")}`, `> ${filter}${c.faint("▏")}`];
      const w = Math.max(20, (stdout.columns || 80) - 4);
      let n = -1;
      for (const row of rows) {
        if (row.heading) {
          lines.push(`  ${c.header(row.heading)}  ${c.faint(`${row.count} script${row.count === 1 ? "" : "s"}`)}`);
          continue;
        }
        n++;
        const s = row.script;
        const status = s.legacy ? "unannotated" : s.status;
        const line =
          `${s.name.padEnd(32)} ${cat.paintTier((s.tier ?? "?").padEnd(22), s.tier, c)} ` +
          `${status === "active" ? "" : c.warn(status.toUpperCase() + " ")}${s.summary}`;
        const clipped = ui.clip(line, w);
        lines.push(n === cursor ? c.bold("❯ ") + clipped : `  ${clipped}`);
      }
      if (!pickable) lines.push(c.faint("  no match"));
      stdout.write(lines.join("\n") + "\n");
      drawn = lines.length;
    };

    const finish = (result) => {
      stdin.setRawMode(false);
      stdin.removeListener("keypress", onKey);
      stdin.pause();
      if (drawn) stdout.write(`\x1b[${drawn}A\x1b[J`);
      resolve(result);
    };

    const onKey = (str, key) => {
      const rows = visible();
      if (key.ctrl && key.name === "c") return finish(null);
      switch (key.name) {
        case "escape":
          return finish(null);
        case "up":
          cursor = Math.max(0, cursor - 1);
          break;
        case "down":
          cursor = Math.min(rows.length - 1, cursor + 1);
          break;
        case "return":
          return rows[cursor] ? finish({ action: "view", script: rows[cursor] }) : null;
        case "backspace":
          filter = filter.slice(0, -1);
          break;
        default:
          if (!filter && str === "q") return finish(null);
          if (!filter && str === "r") return rows[cursor] ? finish({ action: "run", script: rows[cursor] }) : null;
          if (!filter && str === "j") { cursor = Math.min(rows.length - 1, cursor + 1); break; }
          if (!filter && str === "k") { cursor = Math.max(0, cursor - 1); break; }
          if (str && !key.ctrl && !key.meta && str.length === 1 && str >= " ") filter += str;
      }
      draw();
    };

    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKey);
    draw();
  });
}

module.exports = { register };
