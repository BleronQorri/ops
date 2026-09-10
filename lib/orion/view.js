"use strict";

const path = require("path");
const { spawnSync } = require("child_process");
const ui = require("../ui");
const { c } = ui;
const cat = require("./catalogue");

// Body sections shown in DESCRIPTION, in this order. Everything else is only in --raw.
const VIEW_SECTIONS = [/^what it does$/i, /^pipeline$/i, /^modes?$/i, /^safety$/i, /^danger/i, /^prereqs?|prerequisites$/i, /^output$/i, /^exit codes?$/i];
const HELP_TIMEOUT_MS = 5000;

// Run `<entrypoint> --help` and capture it. Only for js scripts that declare a
// help flag: Elixir scripts pay Mix.install on every start.
function liveHelp(script) {
  if (!script.exe || script.docOnly || script.lang !== "js" || !script.help_flag) return null;
  const r = spawnSync(script.exe, ["--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: HELP_TIMEOUT_MS,
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (r.error || r.status !== 0) return null;
  const out = (r.stdout || "").trim() || (r.stderr || "").trim();
  return out || null;
}

// Light markdown -> terminal: fences become indented text, `code` cyan, **x** bold,
// bullets kept, tables kept verbatim, links reduced to their text.
function mdToTerm(lines, indent = "  ") {
  const out = [];
  let inFence = false;
  for (let line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(indent + "  " + c.sql(line));
      continue;
    }
    line = line.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, (_, x) => c.bold(x)).replace(/`([^`]+)`/g, (_, x) => c.sql(x));
    out.push(line.trim() === "" ? "" : indent + line);
  }
  // collapse runs of blank lines; keep the indent of the first line
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").trimEnd();
}

function metaBlock(script) {
  const tier = script.tier
    ? cat.paintTier(`${script.tier} — ${cat.TIERS[script.tier]?.label ?? ""}`, script.tier, c)
    : c.faint("(no frontmatter yet)");
  const rows = [
    ["Env", script.env],
    ["Access", script.access],
    ["Tier", tier],
    ["Status", script.legacy ? c.warn("unannotated") : script.status === "active" ? c.ok("active") : c.warn(script.status.toUpperCase())],
  ];
  if (script.blocked_on) rows.push(["Blocked on", script.blocked_on]);
  if (script.exe) rows.push(["Entrypoint", path.join(script.rel, script.entrypoint)]);
  else rows.push(["Entrypoint", c.faint("none — documentation only")]);
  if (script.also.length) rows.push(["Also", script.also.join(", ")]);
  if (script.aliases.length) rows.push(["Aliases", script.aliases.join(", ")]);
  if (script.related.length) rows.push(["Related", script.related.join(", ")]);
  return rows.map(([k, v]) => `  ${ui.pad(k, 11)} ${v}`).join("\n");
}

function renderView(script, root) {
  const parts = [];
  parts.push(`${c.header(script.name)}${script.summary ? ` — ${script.summary}` : ""}\n\n${metaBlock(script)}`);

  const sections = cat.splitSections(script.body);
  const chosen = [];
  for (const re of VIEW_SECTIONS) for (const s of sections) if (s.level >= 2 && re.test(s.title) && !chosen.includes(s)) chosen.push(s);
  // everything before the first H2 (the H1 title line itself is dropped)
  const preamble = sections.filter((x) => x.level <= 1).flatMap((x) => x.lines).filter((l) => !/^\*\*Env:/.test(l.trim()) && !/^>\s*⚠/.test(l.trim()));
  const preambleText = mdToTerm(preamble);
  const descParts = [];
  if (preambleText) descParts.push(preambleText);
  for (const s of chosen) descParts.push(`  ${c.bold(s.title)}\n${mdToTerm(s.lines)}`);
  if (descParts.length) parts.push(ui.section("DESCRIPTION", descParts.join("\n\n")));

  if (!script.docOnly && script.exe) {
    const help = liveHelp(script);
    if (help) parts.push(ui.section(`SCRIPT HELP  ${c.faint(`(live: ${script.entrypoint} --help)`)}`, help.replace(/^/gm, "  ")));
    else if (script.lang === "exs" && script.help_flag) parts.push(ui.section("SCRIPT HELP", `  Flags: ${c.cmd(`ops run ${script.name} -- --help`)}  ${c.faint("(Elixir, slow start — not run here)")}`));
    else {
      const flags = cat.findSection(sections, /^flags$/i);
      if (flags) parts.push(ui.section("SCRIPT HELP", mdToTerm(flags.lines)));
    }
  }

  if (script.examples.length) {
    parts.push(ui.section("EXAMPLES", ui.examples(script.examples.map((ex) => ({ note: ex.note, cmd: `ops run ${script.name}${ex.args ? " " + ex.args : ""}` })))));
  }

  const learn = [`Full document:  ${c.cmd(`ops orion script view ${script.name} --raw`)}`];
  if (script.exe) learn.push(`Directly:       ${c.cmd(path.join(script.rel, script.entrypoint))}`);
  learn.push(`Tier meanings:  ${c.cmd("ops help tiers")}`);
  parts.push(ui.section("LEARN MORE", learn.map((l) => `  ${l}`).join("\n")));
  return parts.join("\n\n") + "\n";
}

function register(script, { reserved }) {
  const { gh } = require("../program");
  const cmd = script
    .command("view")
    .summary("Show a script's doc page, its live --help and examples")
    .description("Render a gh-style page for one script: summary, tier, status, the key sections of its AGENTS.md, the script's own `--help` output (run live for Node scripts) and runnable examples.\n\nThe page goes through a pager on a terminal (OPS_PAGER / PAGER, default `less -FRX`).")
    .argument("<script>", "script name or alias")
    .option("--raw", "print the script's AGENTS.md verbatim")
    .option("--path", "print the script directory's absolute path and nothing else")
    .option("--no-pager", "do not pipe through a pager")
    .action((token, opts) => {
      const c = cat.loadCatalogue({ reserved });
      const { script: s } = cat.resolveTarget(c, token);
      if (opts.path) return process.stdout.write(s.dir + "\n");
      const text = opts.raw ? s.raw : renderView(s, c.root);
      if (opts.pager === false) process.stdout.write(text);
      else ui.pager(text);
    });
  gh(cmd, {
    usage: ["<script> [flags]"],
    examples: [
      { cmd: "ops orion script view retry_invoices" },
      { cmd: "ops orion script view ri --raw", note: "the whole AGENTS.md" },
      { cmd: "cd \"$(ops orion script view b2b_credit_notes --path)\"", note: "jump to the directory" },
    ],
  });
}

module.exports = { register, renderView, liveHelp, mdToTerm };
