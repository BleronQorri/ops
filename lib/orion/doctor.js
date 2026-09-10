"use strict";

// `ops orion doctor` — is this machine ready to run the scripts?
// Replaces the scripts repo's setup-script-env.js.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const ui = require("../ui");
const { c, ProblemsError } = ui;
const cat = require("./catalogue");

const HOUSTON_AUTH_PROBE = ["auth", "show", "houston"];
const TOOLS = [
  { cmd: "node", why: "Node scripts (.js)", required: true, version: ["--version"], min: 20 },
  { cmd: "elixir", why: "Elixir scripts (.exs)", required: true, version: ["--version"] },
  { cmd: "houston", why: "psql / task run / console / aws-shell", required: true },
  { cmd: "git", why: "version control", required: false },
  { cmd: "pup", why: "Datadog log checks in it_credential_lifecycle_bugbash (optional)", required: false },
];

function which(cmd) {
  const r = spawnSync("sh", ["-lc", `command -v ${cmd}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function run(cmd, args, timeout = 15000) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
  return { ok: !r.error && r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}`, timedOut: r.error?.code === "ETIMEDOUT" };
}

function parseDotenv(file) {
  const out = new Map();
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim().replace(/^["']|["']$/g, ""));
  }
  return out;
}

function toolVersions(root) {
  const p = path.join(root, ".tool-versions");
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const [k, v] = line.trim().split(/\s+/);
    if (k && v) out[k] = v;
  }
  return out;
}

// Each check returns { status: "ok" | "warn" | "fail", label, detail? }
function checks({ fix, probeHouston, reserved }) {
  const results = [];
  const push = (status, label, detail) => results.push({ status, label, detail });

  let root;
  try {
    root = cat.scriptsRoot();
    push("ok", `scripts repo: ${root}`);
  } catch (e) {
    push("fail", "scripts repo not found", e.hint || e.message);
    return results;
  }

  // .env
  const envFile = path.join(root, ".env");
  const example = path.join(root, ".env.example");
  if (!fs.existsSync(example)) push("fail", ".env.example missing in the scripts repo");
  if (fs.existsSync(envFile)) push("ok", ".env exists (never touched by doctor)");
  else if (fix && fs.existsSync(example)) {
    fs.copyFileSync(example, envFile);
    push("ok", ".env created from .env.example — fill the secrets below");
  } else push("fail", ".env missing", `run \`ops orion doctor --fix\` or \`cp .env.example .env\` in ${root}`);

  // secrets: keys shipped blank in .env.example
  const ex = parseDotenv(example);
  const cur = parseDotenv(envFile);
  const required = [...ex.entries()].filter(([, v]) => v === "").map(([k]) => k);
  const unfilled = required.filter((k) => !cur.get(k));
  let catalogue;
  try {
    catalogue = cat.loadCatalogue({ reserved });
  } catch (e) {
    push("fail", "catalogue failed to load", e.message);
  }
  const usedBy = (key) => (catalogue ? catalogue.scripts.filter((s) => s.env_vars.includes(key)).map((s) => s.name) : []);
  if (required.length === 0) push("warn", "no secrets declared blank in .env.example");
  else if (unfilled.length === 0) push("ok", `all ${required.length} secret(s) in .env have values`);
  else for (const k of unfilled) push("warn", `secret ${k} is empty in .env`, usedBy(k).length ? `needed by ${usedBy(k).join(", ")}` : undefined);

  // tools
  const pins = toolVersions(root);
  for (const t of TOOLS) {
    const p = which(t.cmd);
    if (!p) {
      push(t.required ? "fail" : "warn", `${t.cmd} not on PATH`, t.why);
      continue;
    }
    let detail = t.why;
    if (t.version) {
      const r = run(t.cmd, t.version, 20000);
      const m = /(\d+)\.(\d+)\.(\d+)/.exec(r.out);
      if (m) {
        detail = `${m[0]} — ${t.why}`;
        if (t.min && Number(m[1]) < t.min) {
          push("fail", `${t.cmd} ${m[0]} is older than ${t.min}`, t.why);
          continue;
        }
        if (pins[t.cmd] && !pins[t.cmd].startsWith(`${m[1]}.${m[2]}`)) {
          push("warn", `${t.cmd} ${m[0]} differs from .tool-versions (${pins[t.cmd]})`, t.why);
          continue;
        }
      }
    }
    push("ok", `${t.cmd}`, detail);
  }

  // houston auth (opt-in: the probe can trigger an SSO re-login)
  if (which("houston")) {
    if (probeHouston) {
      const r = run("houston", HOUSTON_AUTH_PROBE, 8000);
      if (r.timedOut) push("warn", "houston auth: probe timed out", "run `houston auth refresh houston` yourself");
      else if (/expired|invalid|Failed to get or refresh token/i.test(r.out)) push("warn", "houston SSO session expired", "run `houston auth refresh houston`");
      else if (r.ok) push("ok", "houston auth token present");
      else push("warn", "houston auth: could not verify", r.out.trim().split("\n").pop());
    } else push("ok", "houston on PATH", "auth not probed — add --probe-houston, or run `houston auth show houston`");
  }

  // catalogue
  if (catalogue) {
    const errors = catalogue.problems.filter((p) => p.level === "error");
    const warns = catalogue.problems.filter((p) => p.level === "warn");
    if (errors.length) push("fail", `catalogue: ${errors.length} error(s), ${warns.length} warning(s)`, "run `ops orion docs check`");
    else if (warns.length) push("warn", `catalogue: ${warns.length} warning(s)`, "run `ops orion docs check`");
    else push("ok", `catalogue: ${catalogue.scripts.length} scripts, no problems`);
  }
  return results;
}

function register(orion, { reserved }) {
  const { gh } = require("../program");
  const cmd = orion
    .command("doctor")
    .summary("Check runtimes, .env secrets, houston and the catalogue")
    .description("Check that this machine can run the Orion scripts: the repo is found, `.env` exists and its secrets are filled, `node` / `elixir` / `houston` are on PATH at usable versions, and the catalogue lints clean.\n\nNothing is modified unless `--fix` is given, and `--fix` only ever creates a missing `.env` from `.env.example` — it never overwrites one.")
    .option("--fix", "create .env from .env.example when it is missing")
    .option("--probe-houston", "run `houston auth show houston` to check the SSO session (may trigger a re-login prompt in houston)")
    .option("--json", "output the checks as JSON")
    .helpGroup("MAINTENANCE COMMANDS")
    .action((opts) => {
      const results = checks({ fix: opts.fix, probeHouston: opts.probeHouston, reserved });
      if (opts.json) process.stdout.write(ui.json(results));
      else {
        const mark = { ok: c.ok("✓"), warn: c.warn("!"), fail: c.bad("✗") };
        for (const r of results) process.stdout.write(`${mark[r.status]} ${r.label}${r.detail ? c.faint(`  — ${r.detail}`) : ""}\n`);
      }
      const fails = results.filter((r) => r.status === "fail").length;
      if (fails) throw new ProblemsError(opts.json ? "" : `${fails} check(s) failed`);
    });
  gh(cmd, { usage: ["[flags]"], examples: [{ cmd: "ops orion doctor" }, { cmd: "ops orion doctor --fix", note: "first-time setup" }, { cmd: "ops orion doctor --json | jq '.[] | select(.status != \"ok\")'" }] });
}

module.exports = { register, checks, parseDotenv };
