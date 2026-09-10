"use strict";

const { spawn } = require("child_process");
const path = require("path");
const ui = require("../ui");
const { cerr, UsageError } = ui;
const cat = require("./catalogue");

const SIGNALS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGQUIT: 3, SIGKILL: 9 };

function tierBanner(script, label) {
  const tier = script.tier ? `${script.tier} — ${cat.TIERS[script.tier]?.label ?? ""}` : "tier unknown (no frontmatter)";
  const bits = [`${script.env} · ${script.access} · ${tier}`];
  if (script.status === "deprecated") bits.unshift(cerr.warn("DEPRECATED"));
  return `${cerr.faint("ops ▸")} ${cerr.bold(label)}  ${bits.join("  ")}`;
}

// Spawn the entrypoint exactly as typing its path would: same cwd, same three
// fds, no pty. ops adds no prompts and strips none.
function execScript(exe, args) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { stdio: "inherit", cwd: process.cwd() });
    const ignore = () => {};
    process.on("SIGINT", ignore);
    process.on("SIGTERM", ignore);
    child.on("error", (err) => {
      ui.eprint(`${cerr.bad("error:")} could not start ${exe}: ${err.message}`);
      resolve(2);
    });
    child.on("exit", (code, signal) => {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", ignore);
      resolve(code ?? 128 + (SIGNALS[signal] ?? 0));
    });
  });
}

function register(script, { reserved }) {
  const { gh } = require("../program");
  const cmd = script
    .command("run")
    .summary("Run a script, passing every remaining argument through untouched")
    .description("Run a script by name or alias. Everything after the script token is handed to the script exactly as typed, including `--help`, so `ops orion script run ri --help` shows the script's help and `ops orion script run --help` shows this page.\n\nThe script runs in your current directory with your terminal attached, so its prompts, TTY gates, reports and exit code are identical to running the file directly. ops prints one line on stderr first with the script's environment, access and danger tier, and adds no confirmation of its own.")
    .argument("<script>", "script name, alias, or <name>/<file> for a secondary entrypoint")
    .argument("[args...]", "arguments for the script")
    .passThroughOptions()
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (token, args) => {
      const c = cat.loadCatalogue({ reserved });
      const { script: s, exe, label } = cat.resolveTarget(c, token);
      if (s.docOnly) {
        throw new UsageError(`${s.name} is documentation only (${s.status}) — there is nothing to run`, `Read it with \`ops orion script view ${s.name}\`.${s.blocked_on ? ` Blocked on: ${s.blocked_on}` : ""}`);
      }
      if (!exe) throw new UsageError(`${s.name} has no entrypoint`, "check its AGENTS.md frontmatter (`ops orion docs check`)");
      if (!cat.isExecutable(exe)) throw new UsageError(`${path.relative(c.root, exe)} is not executable`, `chmod +x ${exe}`);
      if (args[0] === "--") args = args.slice(1);
      ui.eprint(tierBanner(s, label));
      process.exitCode = await execScript(exe, args);
    });
  gh(cmd, {
    usage: ["<script> [<script-args>...]"],
    examples: [
      { cmd: "ops orion script run retry_invoices --dry-run 123,456" },
      { cmd: "ops orion script run ri --help", note: "the script's own help (alias from its frontmatter)" },
      { cmd: "ops orion script run b2b_credit_notes/decode_payloads --ids 1 --yes", note: "a secondary entrypoint" },
      { cmd: "cd ~/reports && ops orion script run plugin_legal_entity_updates", note: "reports land in the current directory" },
    ],
  });
}

module.exports = { register, execScript, tierBanner };
