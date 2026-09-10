"use strict";

// `ops orion docs check` — lint the catalogue.
// `ops orion docs sync`  — regenerate the marker-delimited regions in
//                          orion/AGENTS.md and orion/.gitignore.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const ui = require("../ui");
const { c, ProblemsError, UsageError } = ui;
const cat = require("./catalogue");

const MARK_RE = /^(?:<!--|#) ops:(begin|end) ([\w:/.-]+)(?: -->)?\s*$/;

// ---------------------------------------------------------------------------
// Generated regions
// ---------------------------------------------------------------------------

function statusMark(s) {
  if (s.status === "retired") return " 🪦 **RETIRED**";
  if (s.status === "deprecated") return " ⚠️ **DEPRECATED**";
  if (s.status === "blocked") return " ⛔ **BLOCKED**";
  if (s.status === "runbook") return " 📄 *runbook*";
  return "";
}

function runCell(s) {
  if (s.docOnly) return `\`ops orion script view ${s.name}\``;
  const parts = [`\`ops run ${s.name}\``, ...s.aliases.map((a) => `\`ops run ${a}\``)];
  return parts.join(" · ");
}

function mdCell(v) {
  return String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function catalogueTable(scripts) {
  const lines = ["| Script | Tier | Run | What it does |", "|--------|------|-----|--------------|"];
  for (const s of scripts) {
    lines.push(`| [${s.name}](${s.name}/)${statusMark(s)} | ${s.tier ?? "?"} | ${runCell(s)} | ${mdCell(s.summary)}${s.blocked_on ? ` **Blocked on:** ${mdCell(s.blocked_on)}` : ""} |`);
  }
  return lines.join("\n");
}

function tiersList(scripts) {
  const lines = [];
  for (const [id, t] of Object.entries(cat.TIERS)) {
    const names = scripts.filter((s) => s.tier === id && !s.docOnly).map((s) => `\`${s.name}\``);
    const docs = scripts.filter((s) => s.tier === id && s.docOnly).map((s) => `\`${s.name}\` (${s.status})`);
    if (!names.length && !docs.length) continue;
    lines.push(`- **${t.label}** (\`${id}\`) — ${t.blurb}: ${[...names, ...docs].join(", ")}.`);
  }
  lines.push("", "Mode-by-mode nuance lives in each script's own `AGENTS.md`; the tier is the worst thing the script can do in any mode. `ops help tiers` has the long form.");
  return lines.join("\n");
}

// Name, when, why — one line each. The directory and its AGENTS.md stay put.
function retiredList(scripts) {
  if (!scripts.length) return "_Nothing retired yet._";
  const lines = ["| Script | Retired | Why |", "|--------|---------|-----|"];
  for (const s of scripts) {
    lines.push(`| [${s.name}](${s.name}/) | ${s.retired_on || "—"} | ${mdCell(s.retired_reason)} |`);
  }
  lines.push("", "These are decommissioned. They are hidden from `ops orion script list` (use", "`--status retired`) and `ops run` refuses them; the files still run directly if you", "ever need them.");
  return lines.join("\n");
}

function reportsGlobs(scripts) {
  const set = new Set();
  for (const s of scripts) for (const g of s.reports) set.add(g);
  return [...set].sort().join("\n");
}

// { "<file>": { "<region id>": "<content>" } }
function generateRegions(catalogue) {
  // Retired scripts are decommissioned: they stay out of the catalogue and the tier
  // list, and appear only in their own region below.
  const S = catalogue.scripts.filter((s) => !s.retired);
  const retired = catalogue.scripts.filter((s) => s.retired);
  const regions = { "AGENTS.md": {}, ".gitignore": {} };
  for (const env of cat.ENVS) for (const access of cat.ACCESSES) {
    const group = S.filter((s) => s.env === env && s.access === access);
    if (group.length) regions["AGENTS.md"][`catalogue:${env}/${access}`] = catalogueTable(group);
  }
  regions["AGENTS.md"].tiers = tiersList(S);
  regions["AGENTS.md"].retired = retiredList(retired);
  regions[".gitignore"].reports = reportsGlobs(catalogue.scripts);
  return regions;
}

// Locate marker pairs in a file. Returns { ok, regions: Map<id, {start,end}>, errors[] }
function scanMarkers(text) {
  const lines = text.split("\n");
  const regions = new Map();
  const errors = [];
  let open = null;
  lines.forEach((line, i) => {
    const m = MARK_RE.exec(line);
    if (!m) return;
    const [, kind, id] = m;
    if (kind === "begin") {
      if (open) errors.push(`line ${i + 1}: begin ${id} while ${open.id} is still open`);
      if (regions.has(id)) errors.push(`line ${i + 1}: duplicate region ${id}`);
      open = { id, start: i };
    } else {
      if (!open || open.id !== id) errors.push(`line ${i + 1}: end ${id} without a matching begin`);
      else {
        regions.set(id, { start: open.start, end: i });
        open = null;
      }
    }
  });
  if (open) errors.push(`region ${open.id} is never closed`);
  return { lines, regions, errors };
}

// Replace the content between the markers. Returns { text, changed, missing[] }
function applyRegions(text, wanted) {
  const { lines, regions, errors } = scanMarkers(text);
  if (errors.length) throw new ProblemsError(`unbalanced ops markers: ${errors.join("; ")}`);
  const missing = [];
  let out = lines.slice();
  // apply from the bottom so indices stay valid
  const ids = Object.keys(wanted).filter((id) => {
    if (!regions.has(id)) missing.push(id);
    return regions.has(id);
  });
  ids.sort((a, b) => regions.get(b).start - regions.get(a).start);
  for (const id of ids) {
    const { start, end } = regions.get(id);
    out = [...out.slice(0, start + 1), ...wanted[id].split("\n"), ...out.slice(end)];
  }
  const next = out.join("\n");
  return { text: next, changed: next !== text, missing };
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

function probeHelp(script) {
  const r = spawnSync(script.exe, ["--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: script.lang === "exs" ? 90000 : 5000, env: { ...process.env, NO_COLOR: "1" } });
  if (r.error) return `--help probe: ${r.error.code === "ETIMEDOUT" ? "timed out" : r.error.message}`;
  if (r.status !== 0) return `--help probe: exit ${r.status}`;
  if (!(r.stdout || r.stderr || "").trim()) return "--help probe: printed nothing";
  return null;
}

function runCheck({ reserved, probeExs, json }) {
  const catalogue = cat.loadCatalogue({ reserved });
  const problems = [...catalogue.problems];
  for (const s of catalogue.scripts) {
    if (s.legacy || s.docOnly || s.retired || !s.exe || !s.help_flag || !cat.isExecutable(s.exe)) continue;
    if (s.lang === "exs" && !probeExs) continue;
    const msg = probeHelp(s);
    if (msg) problems.push({ level: "error", script: s.name, msg });
  }
  // generated regions
  const regions = generateRegions(catalogue);
  for (const [file, wanted] of Object.entries(regions)) {
    const p = path.join(catalogue.root, file);
    if (!fs.existsSync(p)) {
      problems.push({ level: "error", script: file, msg: "file missing" });
      continue;
    }
    const text = fs.readFileSync(p, "utf8");
    const { errors } = scanMarkers(text);
    if (errors.length) {
      for (const e of errors) problems.push({ level: "error", script: file, msg: e });
      continue;
    }
    const { changed, missing } = applyRegions(text, wanted);
    for (const id of missing) problems.push({ level: "error", script: file, msg: `no \`ops:begin ${id}\` / \`ops:end ${id}\` markers — add them, then \`ops orion docs sync\`` });
    if (changed) problems.push({ level: "error", script: file, msg: "generated region is out of date — run `ops orion docs sync`" });
  }
  return { catalogue, problems };
}

function printProblems(problems) {
  const by = new Map();
  for (const p of problems) {
    if (!by.has(p.script)) by.set(p.script, []);
    by.get(p.script).push(p);
  }
  for (const [name, list] of by) {
    process.stdout.write(`${c.header(name)}\n`);
    for (const p of list) process.stdout.write(`  ${p.level === "error" ? c.bad("✗") : c.warn("!")} ${p.msg}\n`);
  }
}

function register(orion, { reserved }) {
  const { gh } = require("../program");
  const docs = orion
    .command("docs")
    .summary("Lint the catalogue (check) or regenerate the root tables (sync)")
    .description("Keep the orion/ documentation honest. `check` validates every AGENTS.md frontmatter, entrypoint and the generated regions; `sync` rewrites the generated regions from frontmatter.")
    .helpGroup("MAINTENANCE COMMANDS");
  gh(docs, { examples: [{ cmd: "ops orion docs check" }, { cmd: "ops orion docs sync --dry-run" }] });

  const check = docs
    .command("check")
    .summary("Validate frontmatter, entrypoints and generated regions")
    .description("Exit 0 when every script directory has valid frontmatter, its entrypoint is executable with the right shebang and answers `--help`, aliases do not collide, and the generated regions in AGENTS.md / .gitignore match what `sync` would write. Warnings do not fail the check.")
    .option("--probe-exs", "also run `--help` on Elixir scripts (slow: Mix.install)")
    .option("--json", "output problems as JSON")
    .action((opts) => {
      const { catalogue, problems } = runCheck({ reserved, probeExs: opts.probeExs });
      const errors = problems.filter((p) => p.level === "error").length;
      const warns = problems.length - errors;
      if (opts.json) process.stdout.write(ui.json({ scripts: catalogue.scripts.length, errors, warnings: warns, problems }));
      else {
        printProblems(problems);
        process.stdout.write(`${errors ? c.bad(`${errors} error(s)`) : c.ok("0 errors")}, ${warns} warning(s) across ${catalogue.scripts.length} script directories\n`);
      }
      if (errors) throw new ProblemsError("");
    });
  gh(check, { usage: ["[flags]"], examples: [{ cmd: "ops orion docs check" }, { cmd: "ops orion docs check --json | jq '.problems[] | select(.level == \"error\")'" }] });

  const sync = docs
    .command("sync")
    .summary("Regenerate the marker-delimited regions from frontmatter")
    .description("Rewrite only the text between `<!-- ops:begin <id> -->` and `<!-- ops:end <id> -->` (or `# ops:begin` in .gitignore) in orion/AGENTS.md and orion/.gitignore. Everything outside the markers is preserved byte for byte. A file with unbalanced markers is refused; missing marker pairs are reported and never inserted.")
    .option("--dry-run", "report which files would change without writing")
    .action((opts) => {
      const catalogue = cat.loadCatalogue({ reserved });
      const regions = generateRegions(catalogue);
      let changed = 0;
      const missing = [];
      for (const [file, wanted] of Object.entries(regions)) {
        const p = path.join(catalogue.root, file);
        if (!fs.existsSync(p)) throw new UsageError(`${file} missing in ${catalogue.root}`);
        const text = fs.readFileSync(p, "utf8");
        const r = applyRegions(text, wanted);
        for (const id of r.missing) missing.push(`${file}: ${id}`);
        if (r.changed) {
          changed++;
          if (opts.dryRun) process.stdout.write(`${c.warn("would update")} ${file}\n`);
          else {
            fs.writeFileSync(p, r.text);
            process.stdout.write(`${c.ok("updated")} ${file}\n`);
          }
        } else process.stdout.write(`${c.faint("unchanged")} ${file}\n`);
      }
      if (missing.length) {
        for (const m of missing) process.stdout.write(`${c.bad("no markers for")} ${m}\n`);
        throw new ProblemsError("add the missing marker pairs, then re-run");
      }
      if (!changed) process.stdout.write(c.faint("everything already in sync\n"));
    });
  gh(sync, { usage: ["[flags]"], examples: [{ cmd: "ops orion docs sync --dry-run" }, { cmd: "ops orion docs sync && git -C \"$(ops config get orion.scripts)\" diff --stat" }] });
}

module.exports = { register, generateRegions, applyRegions, scanMarkers, runCheck, MARK_RE };
