"use strict";

// The secrets store: a git-ignored `.env` that ops loads into the environment of
// every run, so a script that prompts for a token when one is unset stops
// prompting once that token has been given.
//
//   <ops repo>/.env   the file: KEY=value per line, mode 0600, git-ignored
//   OPS_ENV_FILE      points somewhere else
//
// ops never takes a secret from a script's own prompt. `ops run` hands the script
// the terminal and never reads its input, and the captured log would hold
// whatever the script echoed. So ops asks first instead — for the secrets a
// script declares in its frontmatter and cannot find in the environment — saves
// the answer here and passes it in, and the script never asks at all.
//
// Precedence is the useful way round: what your shell exported beats the file, so
// `INVOPOP_API_TOKEN=other ops run …` is still a one-off with a different token.
//
// A saved secret expires, and a variable that is set silences the script's own
// prompt — so a stale one turns a question into a 401. Three things answer that:
// a JWT is checked against its own `exp` before the run and a dead one is asked
// for again; every value carries the day it was saved; and a run that was given a
// saved secret and then failed is offered a replacement on the spot.
//
// A secret never reaches a run record. `-p` parameters are written to the record
// in plain text (which is why the help says not to pass a secret that way);
// secrets go into the child's environment and nowhere else, and the record keeps
// only their names.

const fs = require("fs");
const path = require("path");
const ui = require("./ui");
const { UsageError } = ui;

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MODE = 0o600;
const HEADER = "# ops secrets — git-ignored, mode 0600. Written by `ops secrets set`\n# and by `ops run` when a script declares a secret you have not given yet.\n";

const FILE = process.env.OPS_ENV_FILE || path.resolve(__dirname, "..", ".env");

function checkName(name) {
  if (!NAME_RE.test(String(name))) {
    throw new UsageError(`invalid secret name: ${name}`, "names are letters, digits and _, not starting with a digit");
  }
  return name;
}

// The key's line, with the `# saved <date>` line above it when there is one, as
// one unit — so a replacement updates both and a removal takes both away.
function blockRe(name) {
  return new RegExp(`^(?:#[ \\t]*saved[ \\t]+\\S+[ \\t]*\\r?\\n)?[ \\t]*(?:export[ \\t]+)?${checkName(name)}[ \\t]*=.*(?:\\r?\\n|$)`, "m");
}

// --- the file ----------------------------------------------------------------

function raw() {
  try {
    return fs.readFileSync(FILE, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new UsageError(`could not read ${FILE}: ${e.message}`);
  }
}

// KEY=value per line. `export KEY=value`, `# comments` and blank lines are
// understood; a value may be bare, 'single quoted' (literal) or "double quoted"
// (\n, \t and \" mean what they do everywhere else).
function parse(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = unquote(m[2]);
  }
  return out;
}

function unquote(v) {
  const s = v.trim();
  if (s.length > 1 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  if (s.length > 1 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\(["\\])/g, "$1");
  }
  return s.replace(/\s+#.*$/, "").trim(); // a trailing comment on a bare value
}

function quote(v) {
  const s = String(v);
  if (s !== "" && !/[\s"'#\\]/.test(s)) return s;
  return '"' + s.replace(/([\\"])/g, "\\$1").replace(/\n/g, "\\n").replace(/\t/g, "\\t") + '"';
}

function load() {
  const text = raw();
  return text === null ? {} : parse(text);
}

function get(name) {
  return load()[checkName(name)];
}

function names() {
  return Object.keys(load()).sort();
}

function exists() {
  return raw() !== null;
}

// Rewrite one key in place, leaving every comment and every other line alone.
// The replacement is a function, not a string: a secret can hold $& or $` and
// those mean something to String.replace.
function set(name, value) {
  checkName(name);
  const text = raw();
  const block = `# saved ${new Date().toISOString().slice(0, 10)}\n${name}=${quote(value)}\n`;
  let next;
  if (text === null) next = `${HEADER}\n${block}`;
  else if (blockRe(name).test(text)) next = text.replace(blockRe(name), () => block);
  else next = `${text.replace(/\n*$/, "\n")}\n${block}`;
  write(next);
  return name;
}

function unset(name) {
  const text = raw();
  if (text === null) return false;
  if (!blockRe(name).test(text)) return false;
  write(text.replace(blockRe(name), () => ""));
  return true;
}

// 0600 from the moment it exists: created with it, and brought back to it on
// every write.
function write(text) {
  fs.writeFileSync(FILE, text, { mode: MODE });
  try {
    fs.chmodSync(FILE, MODE);
  } catch {
    /* someone else's file: the content is written, the mode is their business */
  }
}

// The mode as four octal digits, or null when there is no file yet.
function mode() {
  try {
    return (fs.statSync(FILE).mode & 0o777).toString(8).padStart(4, "0");
  } catch {
    return null;
  }
}

// --- staleness ---------------------------------------------------------------

// The `# saved <date>` line kept above the key, as a Date, or null.
function savedAt(name) {
  const text = raw();
  if (text === null) return null;
  const m = new RegExp(`^#[ \\t]*saved[ \\t]+(\\S+)[ \\t]*\\r?\\n[ \\t]*(?:export[ \\t]+)?${checkName(name)}[ \\t]*=`, "m").exec(text);
  const d = m ? new Date(m[1]) : null;
  return d && !isNaN(d.getTime()) ? d : null;
}

function age(name) {
  const at = savedAt(name);
  if (!at) return "";
  const d = Math.floor((Date.now() - at.getTime()) / 86400000);
  return d <= 0 ? "saved today" : d === 1 ? "saved yesterday" : `saved ${d}d ago`;
}

// A JWT says when it dies, and says it offline. Anything else — an opaque API
// token — has no expiry ops can read, and returns null.
function jwtExpiry(value) {
  const parts = String(value).split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (typeof claims.exp !== "number") return null;
    const d = new Date(claims.exp * 1000);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function expired(value, now = Date.now()) {
  const exp = jwtExpiry(value);
  return exp !== null && exp.getTime() <= now;
}

// --- asking ------------------------------------------------------------------

// Read one line with the echo off. Null on Ctrl-C or an empty answer, so a caller
// can tell "skip this" from a value. The prompt goes to stderr: stdout is data,
// and a secret is neither.
function ask(label) {
  return new Promise((resolve) => {
    const { stdin, stderr } = process;
    if (!stdin.isTTY) return resolve(null);
    stderr.write(label);
    let buf = "";
    const done = (value) => {
      stdin.setRawMode(false);
      stdin.removeListener("data", onData);
      stdin.pause();
      stderr.write("\n");
      resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") return done(buf.length ? buf : null);
        if (ch === "\x03" || ch === "\x04") return done(null); // Ctrl-C, Ctrl-D
        if (ch === "\x7f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

// One keypress, y or n, default no. Echoed — there is nothing secret about it.
function confirm(label) {
  return new Promise((resolve) => {
    const { stdin, stderr } = process;
    if (!stdin.isTTY) return resolve(false);
    stderr.write(label);
    const onData = (chunk) => {
      const ch = String(chunk)[0] || "";
      stdin.setRawMode(false);
      stdin.removeListener("data", onData);
      stdin.pause();
      const yes = ch === "y" || ch === "Y";
      stderr.write(`${yes ? "y" : "n"}\n`);
      resolve(yes);
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

// --- what a run gets ---------------------------------------------------------

// `declared` are the secrets the script says it needs. Anything already exported
// wins and is left alone; anything saved here is passed through; anything missing
// from both — or saved but demonstrably expired — is asked for once and saved.
//
// A refusal is never fatal: the value is simply not passed, and the script asks
// for it the way it always has.
async function forRun(declared = [], { prompt = true, label = "" } = {}) {
  const file = load();
  const asked = [];
  const dead = [];

  const wanted = (name) => {
    if (process.env[name] !== undefined) return null; // the shell wins
    const saved = file[name];
    if (saved === undefined) return "missing";
    if (expired(saved)) return "expired";
    return null;
  };

  if (prompt && process.stdin.isTTY && process.stderr.isTTY) {
    for (const name of declared) {
      const why = wanted(name);
      if (!why) continue;
      if (why === "expired") {
        dead.push(name);
        delete file[name]; // never hand a script a token that is already dead
        ui.eprint(
          `${ui.cerr.faint("ops ▸")} ${ui.cerr.warn(name)} expired ${ui.cerr.faint(`on ${jwtExpiry(load()[name]).toISOString().slice(0, 10)} (${age(name)})`)}`
        );
      } else {
        ui.eprint(`${ui.cerr.faint("ops ▸")} ${label ? `${ui.cerr.bold(label)} needs ` : "needs "}${ui.cerr.bold(name)}`);
      }
      ui.eprint(ui.cerr.faint(`  saved to ${FILE} (0600, git-ignored) · Enter to skip and let the script ask`));
      const value = await ask(`  ${name}: `);
      if (value === null) continue;
      set(name, value);
      file[name] = value;
      asked.push(name);
    }
  } else {
    // No terminal to ask on: an expired value is still withheld rather than
    // handed over, so the script's own path is the one that runs.
    for (const name of declared) {
      if (wanted(name) === "expired") {
        dead.push(name);
        delete file[name];
      }
    }
  }

  // Every live value in the file goes to the child, not just the declared ones:
  // a script ops knows nothing about still gets what your .env holds.
  for (const [name, value] of Object.entries(file)) if (expired(value)) delete file[name];
  const supplied = Object.keys(file).filter((n) => process.env[n] === undefined);
  return { env: file, supplied, asked, expired: dead };
}

// After a failed run that was given saved secrets: ops cannot tell a bad token
// from a bad argument, so it asks rather than assumes, and only on a terminal.
async function offerReplacement(names_, { label = "" } = {}) {
  const relevant = names_.filter((n) => load()[n] !== undefined);
  if (!relevant.length || !process.stdin.isTTY || !process.stderr.isTTY) return [];
  const replaced = [];
  for (const name of relevant) {
    const when = age(name);
    ui.eprint(
      `${ui.cerr.faint("ops ▸")} ${label ? `${label} ` : ""}failed, and was given ${ui.cerr.bold(name)} from ${FILE}${when ? ui.cerr.faint(` (${when})`) : ""}`
    );
    if (!(await confirm("  replace it? [y/N] "))) continue;
    const value = await ask(`  ${name}: `);
    if (value === null) {
      unset(name);
      ui.eprint(ui.cerr.faint(`  ${name} removed — the script will ask for it next time`));
      replaced.push(name);
      continue;
    }
    set(name, value);
    replaced.push(name);
  }
  return replaced;
}

module.exports = {
  FILE,
  NAME_RE,
  checkName,
  parse,
  quote,
  load,
  get,
  names,
  exists,
  set,
  unset,
  mode,
  savedAt,
  age,
  jwtExpiry,
  expired,
  ask,
  confirm,
  forRun,
  offerReplacement,
};
