"use strict";

// One frame of a raw-mode list: a title, a filter line, headings the cursor
// skips, one highlighted row, and a window that follows the cursor when the list
// is longer than the terminal.
//
// A call draws one frame and resolves the moment a key means something; the
// caller acts on it and calls again. The frame erases itself on the way out, so
// everything that takes over the terminal — a pager, a script's own prompts and
// output — happens between frames and behaves exactly as it does when the
// command is typed by hand.
//
// Two ways to filter, because the screens want different things:
//
//   "type"   every printable key extends the filter, and the letter commands
//            only work while it is empty. Right for a screen with two verbs.
//   "slash"  `/` opens the filter, Enter closes it, Esc clears it, and letters
//            are commands the rest of the time. Right for a screen with a keymap
//            worth more than the two letters a filter would otherwise swallow.

const readline = require("readline");
const ui = require("./ui");
const { c } = ui;

const CHROME = 3; // title, filter line, and a line left for whatever comes next
const MIN_ROWS = 3;

// A lone Esc never reaches readline: node holds the byte to see whether it opens
// an escape sequence, and turns the key after it into a meta one instead — which
// is why an Esc on its own used to do nothing at all. So Esc is read from the raw
// stream after a short wait, and the meta key that follows it is put back the way
// it was typed.
const ESC_MS = 50;

function onKeys(stdin, handler) {
  let escTimer = null;
  let pendingMeta = false;

  const onData = (chunk) => {
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
    }
    if (String(chunk) !== "\x1b") return;
    escTimer = setTimeout(() => {
      escTimer = null;
      pendingMeta = true;
      handler(undefined, { name: "escape", sequence: "\x1b", ctrl: false, meta: false, shift: false });
    }, ESC_MS);
  };

  const onKey = (str, key = {}) => {
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
    }
    if (key.meta && pendingMeta) {
      pendingMeta = false;
      const bare = String(key.sequence || "").replace(/^\x1b+/, "");
      key = { ...key, meta: false, sequence: bare };
      if (bare.length === 1) str = bare;
    }
    handler(str, key);
  };

  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onData);
  stdin.on("keypress", onKey);

  return () => {
    clearTimeout(escTimer);
    stdin.removeListener("data", onData);
    stdin.removeListener("keypress", onKey);
    stdin.setRawMode(false);
    stdin.pause();
  };
}

// groups(filter) -> [{ heading, note, items: [{ value, render(width, selected) }] }]
// keys           -> { "<char>": "<action>" }, consulted before the built-ins
//
// Resolves null when the frame was dismissed (q, Esc, Ctrl-C), else
// { action, value, filter, cursor } — value is null when nothing was selectable,
// so an action that needs one has to say so itself.
function select({ title, hint, groups, keys = {}, mode = "type", empty = "no match", footer = null, filter = "", cursor = 0 }) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    let typing = mode === "type";
    let drawn = 0;
    let detach = null;

    const build = () => {
      const lines = [];
      const values = [];
      for (const g of groups(filter)) {
        if (!g.items || !g.items.length) continue;
        if (g.heading) lines.push({ heading: g.heading, note: g.note });
        for (const item of g.items) {
          lines.push({ item, at: values.length });
          values.push(item.value);
        }
      }
      return { lines, values };
    };

    const viewport = () => Math.max(MIN_ROWS, (stdout.rows || 24) - CHROME - (footer ? 1 : 0) - 1);

    const filterLine = () => {
      if (typing) return `${c.bold(">")} ${filter}${c.faint("▏")}`;
      if (filter) return `${c.faint("filter")} ${filter}  ${c.faint("· / edit · esc clear")}`;
      return c.faint("/ to filter");
    };

    const draw = () => {
      if (drawn) stdout.write(`\x1b[${drawn}A\x1b[J`);
      const { lines, values } = build();
      cursor = Math.min(Math.max(0, cursor), Math.max(0, values.length - 1));
      const w = Math.max(20, (stdout.columns || 80) - 4);
      const h = viewport();
      const at = lines.findIndex((l) => l.item && l.at === cursor);

      // Keep the cursor in the middle of the window when the list is long enough
      // to need one; a window that starts mid-group still says which group it is.
      let start = 0;
      if (lines.length > h) start = Math.max(0, Math.min(Math.max(at, 0) - Math.floor(h / 2), lines.length - h));
      const win = lines.slice(start, start + h);
      if (start > 0 && win.length && !win[0].heading) {
        const above = lines.slice(0, start).reverse().find((l) => l.heading);
        if (above) {
          win.unshift({ heading: above.heading, note: "continued" });
          win.pop();
        }
      }

      const out = [ui.clip(`${c.header(title)}  ${c.faint(hint)}`, w), filterLine()];
      for (const l of win) {
        if (l.heading) {
          out.push(`  ${c.header(l.heading)}${l.note ? `  ${c.faint(l.note)}` : ""}`);
          continue;
        }
        const selected = l.at === cursor;
        const line = ui.clip(l.item.render(w - 2, selected), w - 2);
        out.push(selected ? `${c.bold("❯")} ${line}` : `  ${line}`);
      }
      if (!values.length) out.push(`  ${c.faint(empty)}`);

      const shown = win.filter((l) => l.item);
      if (shown.length && shown.length < values.length) {
        const first = shown[0].at + 1;
        out.push(c.faint(`  ⋮ ${first}–${shown[shown.length - 1].at + 1} of ${values.length}`));
      }
      if (footer) out.push(c.faint(`  ${footer}`));

      stdout.write(out.join("\n") + "\n");
      drawn = out.length;
    };

    const finish = (result) => {
      if (detach) detach();
      if (drawn) stdout.write(`\x1b[${drawn}A\x1b[J`);
      drawn = 0;
      resolve(result);
    };

    const done = (action) => finish({ action, value: build().values[cursor] ?? null, filter, cursor });

    const onKey = (str, key) => {
      const { values } = build();
      const last = values.length - 1;
      const page = Math.max(1, viewport() - 2);
      const printable = Boolean(str) && !key.ctrl && !key.meta && str.length === 1 && str >= " ";
      const commanding = mode === "slash" ? !typing : !filter;

      if (key.ctrl && key.name === "c") return finish(null);
      switch (key.name) {
        case "up":
          cursor = Math.max(0, cursor - 1);
          break;
        case "down":
          cursor = Math.min(last, cursor + 1);
          break;
        case "pageup":
          cursor = Math.max(0, cursor - page);
          break;
        case "pagedown":
          cursor = Math.min(last, cursor + page);
          break;
        case "home":
          cursor = 0;
          break;
        case "end":
          cursor = Math.max(0, last);
          break;
        case "tab":
          return done("tab");
        case "escape":
          if (mode === "slash" && (typing || filter)) {
            typing = false;
            filter = "";
            break;
          }
          return finish(null);
        case "return":
          if (typing && mode === "slash") {
            typing = false;
            break;
          }
          if (!values.length) return;
          return done("default");
        case "backspace":
          if (typing) filter = filter.slice(0, -1);
          break;
        default:
          if (printable && commanding && keys[str]) return done(keys[str]);
          if (printable && commanding && str === "q") return finish(null);
          if (printable && commanding && str === "/" && mode === "slash") {
            typing = true;
            break;
          }
          if (printable && commanding && (str === "j" || str === "k")) {
            cursor = str === "j" ? Math.min(last, cursor + 1) : Math.max(0, cursor - 1);
            break;
          }
          if (printable && typing) filter += str;
          else if (printable) return; // an unbound command key: nothing to redraw
          break;
      }
      draw();
    };

    detach = onKeys(stdin, onKey);
    draw();
  });
}

// Hold the terminal until a key is pressed — used after a run, so its output can
// be read before the next frame draws over the prompt.
function pause(message = "press any key") {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(c.faint(`\n${message}`));
    const detach = onKeys(stdin, () => {
      detach();
      stdout.write("\r\x1b[J");
      resolve();
    });
  });
}

module.exports = { select, pause };
