#!/usr/bin/env node

// setup-script-env.js — one-time environment setup for einvoicing-scripts.
//
// What it does (all idempotent, safe to re-run):
//   1. Scaffolds `.env` from `.env.example` if it doesn't exist yet.
//      NEVER overwrites an existing `.env`.
//   2. Reports which secrets in `.env` still need a value.
//   3. Checks the runtimes / CLIs the scripts need are on PATH.
//
// Usage:
//   ./setup-script-env.js
//   node setup-script-env.js

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = __dirname;
const ENV = path.join(ROOT, ".env");
const EXAMPLE = path.join(ROOT, ".env.example");

const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const warn = (s) => `\x1b[33m!\x1b[0m ${s}`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

let problems = 0;

// Parse KEY=VALUE lines from a dotenv-style file into a Map (order preserved).
function parseEnv(file) {
  const out = new Map();
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    out.set(key, val);
  }
  return out;
}

function onPath(cmd) {
  const r = spawnSync("bash", ["-lc", `command -v ${cmd}`], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() !== "";
}

console.log(bold("\neinvoicing-scripts — environment setup\n"));

// --- 1. .env scaffolding ----------------------------------------------------
if (!fs.existsSync(EXAMPLE)) {
  console.log(bad(`.env.example not found at ${EXAMPLE} — run this from the repo root.`));
  process.exit(1);
}

if (fs.existsSync(ENV)) {
  console.log(ok(".env already exists (left untouched)."));
} else {
  fs.copyFileSync(EXAMPLE, ENV);
  console.log(ok("Created .env from .env.example."));
}

// --- 2. required-secret check -----------------------------------------------
// "Required" = keys shipped blank in .env.example (the secrets). Keys with a
// default value in the example (base URLs, workflow UUIDs) are not required.
const example = parseEnv(EXAMPLE);
const current = parseEnv(ENV);
const required = [...example.entries()].filter(([, v]) => v === "").map(([k]) => k);

const unfilled = required.filter((k) => !current.get(k));
console.log("");
if (unfilled.length === 0) {
  console.log(ok("All required secrets in .env have values."));
} else {
  problems += unfilled.length;
  console.log(warn(`${unfilled.length} required secret(s) in .env still empty — fill before use:`));
  for (const k of unfilled) console.log(`    ${k}`);
}

// --- 3. runtime / CLI checks ------------------------------------------------
// { cmd, why, required }
const TOOLS = [
  { cmd: "node", why: "Node scripts (retry_invoices, confirm_sent_uat)", required: true },
  { cmd: "elixir", why: "Elixir scripts (.exs)", required: true },
  { cmd: "houston", why: "psql / task-run / aws-shell (most prod + staging scripts)", required: true },
  { cmd: "git", why: "version control", required: false },
];

console.log("");
console.log(bold("Runtimes / CLIs:"));
for (const { cmd, why, required: req } of TOOLS) {
  if (onPath(cmd)) {
    console.log("  " + ok(`${cmd}  — ${why}`));
  } else if (req) {
    problems++;
    console.log("  " + bad(`${cmd}  — MISSING. Needed for: ${why}`));
  } else {
    console.log("  " + warn(`${cmd}  — not found (optional: ${why})`));
  }
}

// --- next steps -------------------------------------------------------------
console.log("");
console.log(bold("Next:"));
console.log("  1. Fill secrets in .env  (see .env.example for what each is).");
console.log("  2. Ensure VPN is up and `houston` is authenticated.");
console.log("  3. Run a script, e.g.:");
console.log("       ./production/read-only/invopop_supplier_check/invopop_supplier_check.exs");
console.log("");

if (problems > 0) {
  console.log(warn(`${problems} thing(s) need attention above.\n`));
  process.exit(1);
}
console.log(ok("Environment ready.\n"));
