"use strict";

// Terminal helpers shared by every command.
//
// House rules (same as the Orion scripts themselves):
//   - colour only when the stream is a TTY and NO_COLOR is unset
//   - stdout carries data, stderr carries diagnostics
//   - tables: headers + padding on a TTY, tab-separated with no header when piped

const { spawnSync } = require("child_process");

const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const COLOR_ERR = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;

function sgr(code, enabled) {
  return (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s));
}

function palette(enabled) {
  return {
    header: sgr("1;37", enabled), // section headers
    cmd: sgr("33", enabled), // a command you could run yourself
    sql: sgr("36", enabled), // a query about to run / inline code
    faint: sgr("2", enabled), // progress, comments
    ok: sgr("32", enabled),
    bad: sgr("31", enabled),
    warn: sgr("1;33", enabled),
    bold: sgr("1", enabled),
  };
}

const c = palette(COLOR);
const cerr = palette(COLOR_ERR);

function width() {
  return process.stdout.columns || 80;
}

// Visible width, ignoring SGR escapes.
function displayWidth(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "").length;
}

function pad(s, n) {
  const w = displayWidth(s);
  return w >= n ? String(s) : String(s) + " ".repeat(n - w);
}

// rows: array of arrays of strings. cols: array of header labels.
//
// TTY  -> a box-drawn table with a header, in the same shape the Orion scripts
//         themselves print, so ops output and script output read as one thing.
// pipe -> TSV, no header, no borders, no colour, so `cut -f1` still works.
//         This is gh's rule: a terminal gets a table, a pipe gets fields.
//
// A column whose every cell is a number is right-aligned. When the table is wider
// than the terminal, the widest column is truncated with an ellipsis rather than
// letting the borders wrap into rubble.
function table(rows, cols, { tty = process.stdout.isTTY, maxWidth = width() } = {}) {
  if (!tty) return rows.map((r) => r.map((v) => String(v ?? "")).join("\t")).join("\n") + (rows.length ? "\n" : "");

  const cells = rows.map((r) => cols.map((_, i) => String(r[i] ?? "")));
  const numeric = cols.map((_, i) => cells.length > 0 && cells.every((r) => /^-?\d+$/.test(displayText(r[i]).trim())));
  let widths = cols.map((_, i) => Math.max(displayWidth(cols[i]), ...cells.map((r) => displayWidth(r[i])), 1));

  // borders and padding cost 3 per column plus one closing bar
  const chrome = widths.length * 3 + 1;
  let over = widths.reduce((a, b) => a + b, 0) + chrome - maxWidth;
  const last = widths.length - 1;
  while (over > 0) {
    // the last column is usually prose and is the first to give; then the widest
    const from = widths[last] > 12 ? last : widths.indexOf(Math.max(...widths));
    const floor = from === last ? 12 : 8;
    if (widths[from] <= floor) break; // nothing left worth taking
    const take = Math.min(over, widths[from] - floor);
    widths[from] -= take;
    over -= take;
  }

  const fit = (s, w) => (displayWidth(s) <= w ? s : clip(s, w));
  const rule = (l, m, r) => l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const line = (r) =>
    "│ " + r.map((cell, i) => padTo(fit(cell, widths[i]), widths[i], numeric[i])).join(" │ ") + " │";

  return (
    [rule("┌", "┬", "┐"), line(cols.map((h) => c.header(h))), rule("├", "┼", "┤"), ...cells.map(line), rule("└", "┴", "┘")].join("\n") + "\n"
  );
}

// The text as the eye sees it, without the escape bytes.
function displayText(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

// Truncate to `w` visible columns, keeping every escape sequence on the way — a
// composed line can change colour several times, and slicing the plain text would
// throw all of that away.
function clip(str, w) {
  const s = String(str);
  if (displayWidth(s) <= w) return s;
  const budget = Math.max(0, w - 1); // room for the ellipsis
  let out = "";
  let seen = 0;
  let coloured = false;
  for (let i = 0; i < s.length; ) {
    const esc = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
    if (esc) {
      out += esc[0];
      coloured = true;
      i += esc[0].length;
      continue;
    }
    if (seen >= budget) break;
    out += s[i];
    seen++;
    i++;
  }
  return out + "…" + (coloured ? "\x1b[0m" : "");
}

function padTo(s, w, right) {
  const gap = " ".repeat(Math.max(0, w - displayWidth(s)));
  return right ? gap + String(s) : String(s) + gap;
}

function json(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

// Wrap plain text at `w`, prefixing every line with `indent`.
function wrap(text, w = width(), indent = "") {
  const out = [];
  for (const para of String(text).split("\n")) {
    if (para.trim() === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (line && displayWidth(line) + 1 + displayWidth(word) > w - indent.length) {
        out.push(indent + line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) out.push(indent + line);
  }
  return out.join("\n");
}

// gh-style EXAMPLES block: `# note` lines faint, `$ cmd` lines in cmd colour.
function examples(items, indent = "  ") {
  const lines = [];
  for (const ex of items) {
    if (ex.note) lines.push(indent + c.faint(`# ${ex.note}`));
    lines.push(indent + c.cmd(`$ ${ex.cmd}`));
  }
  return lines.join("\n");
}

function section(title, body) {
  return `${c.header(title)}\n${body}`;
}

// Pipe text through a pager when stdout is a TTY. OPS_PAGER / PAGER; "" disables.
function pager(text) {
  const cmd = process.env.OPS_PAGER ?? process.env.PAGER ?? "less -FRX";
  if (!process.stdout.isTTY || cmd.trim() === "") {
    process.stdout.write(text);
    return;
  }
  const r = spawnSync("sh", ["-c", cmd], { input: text, stdio: ["pipe", "inherit", "inherit"] });
  if (r.error) process.stdout.write(text);
}

function eprint(s) {
  process.stderr.write(String(s) + "\n");
}

class UsageError extends Error {
  constructor(msg, hint) {
    super(msg);
    this.hint = hint;
    this.exitCode = 2;
  }
}

class ProblemsError extends Error {
  constructor(msg) {
    super(msg);
    this.exitCode = 1;
  }
}

module.exports = {
  COLOR,
  COLOR_ERR,
  c,
  cerr,
  width,
  displayWidth,
  pad,
  table,
  displayText,
  clip,
  padTo,
  json,
  wrap,
  examples,
  section,
  pager,
  eprint,
  UsageError,
  ProblemsError,
};
