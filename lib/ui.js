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
// TTY  -> padded columns with a header row.
// pipe -> TSV, no header, no colour (script-friendly, like `gh` non-TTY output).
function table(rows, cols, { tty = process.stdout.isTTY } = {}) {
  if (!tty) return rows.map((r) => r.map((v) => String(v ?? "")).join("\t")).join("\n") + (rows.length ? "\n" : "");
  const all = [cols, ...rows];
  const widths = cols.map((_, i) => Math.max(...all.map((r) => displayWidth(r[i] ?? ""))));
  const line = (r) => r.map((v, i) => (i === r.length - 1 ? String(v ?? "") : pad(v ?? "", widths[i]))).join("  ");
  return [c.header(line(cols)), ...rows.map(line)].join("\n") + "\n";
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
  json,
  wrap,
  examples,
  section,
  pager,
  eprint,
  UsageError,
  ProblemsError,
};
