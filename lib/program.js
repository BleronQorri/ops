"use strict";

// Root commander program: groups, core commands, help topics and the gh-style
// help formatter every command page uses.

const { Command, Help, Option } = require("commander");
const pkg = require("../package.json");
const ui = require("./ui");
const config = require("./config");
const { c, UsageError } = ui;

// ---------------------------------------------------------------------------
// gh-style help
//
//   <long description>
//
//   USAGE
//     ops run <script> [<script-args>...]
//
//   <COMMAND GROUPS> / FLAGS / INHERITED FLAGS / EXAMPLES / LEARN MORE
// ---------------------------------------------------------------------------

// Help groups appear in this order wherever they occur; anything unlisted keeps
// its insertion order after these.
const GROUP_ORDER = ["SCRIPT COMMANDS", "GROUPS", "MAINTENANCE COMMANDS", "CORE COMMANDS", "COMMANDS", "HELP TOPICS"];

function orderGroups(groups) {
  const rank = (name) => {
    const i = GROUP_ORDER.indexOf(name);
    return i === -1 ? GROUP_ORDER.length : i;
  };
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
}

function commandPath(cmd) {
  const parts = [];
  for (let cur = cmd; cur; cur = cur.parent) parts.unshift(cur.name());
  return parts.join(" ");
}

class GhHelp extends Help {
  formatHelp(cmd, helper) {
    const termWidth = Math.max(
      0,
      ...helper.visibleCommands(cmd).map((sub) => ui.displayWidth(`${sub.name()}:`)),
      ...helper.visibleOptions(cmd).map((o) => ui.displayWidth(helper.optionTerm(o))),
      ...helper.visibleGlobalOptions(cmd).map((o) => ui.displayWidth(helper.optionTerm(o))),
      ...helper.visibleArguments(cmd).map((a) => ui.displayWidth(helper.argumentTerm(a)))
    );
    const item = (term, desc) => helper.formatItem(term, termWidth, desc, helper);
    const sections = [];

    const long = cmd.description() || cmd.summary() || "";
    if (long) sections.push(ui.wrap(long, helper.helpWidth ?? 80));

    const usage = cmd._opsUsage ?? defaultUsage(cmd);
    sections.push(ui.section("USAGE", usage.map((u) => `  ${commandPath(cmd)} ${u}`.trimEnd()).join("\n")));


    const groups = this.groupItems(cmd.commands, helper.visibleCommands(cmd), (sub) => sub.helpGroup() || "COMMANDS");
    for (const [heading, cmds] of orderGroups(groups)) {
      const lines = cmds.map((sub) => item(`${sub.name()}:`, sub.summary() || sub.description()));
      sections.push(ui.section(heading, lines.join("\n")));
    }

    const fmt = (o) => item(helper.optionTerm(o), helper.optionDescription(o));
    const visible = helper.visibleOptions(cmd);
    if (!cmd.parent) {
      // root: FLAGS holds --help and --version
      sections.push(ui.section("FLAGS", visible.map(fmt).join("\n")));
    } else {
      const own = visible.filter((o) => !isHelpOption(o));
      if (own.length) sections.push(ui.section("FLAGS", own.map(fmt).join("\n")));
      const inherited = [...visible.filter(isHelpOption), ...helper.visibleGlobalOptions(cmd)];
      sections.push(ui.section("INHERITED FLAGS", inherited.map(fmt).join("\n")));
    }

    if (cmd._opsExamples?.length) sections.push(ui.section("EXAMPLES", ui.examples(cmd._opsExamples)));

    const learn = cmd._opsLearnMore ?? defaultLearnMore(cmd);
    if (learn.length) sections.push(ui.section("LEARN MORE", learn.map((l) => `  ${l}`).join("\n")));

    return sections.join("\n\n") + "\n";
  }
}

// Every node in the tree is an OpsCommand so the gh formatter applies to all.
class OpsCommand extends Command {
  createCommand(name) {
    return new OpsCommand(name).helpCommand(false);
  }
  createHelp() {
    return Object.assign(new GhHelp(), this.configureHelp());
  }
}

function isHelpOption(o) {
  return o.long === "--help";
}

function defaultUsage(cmd) {
  const args = cmd.registeredArguments.map((a) => (a.required ? `<${a.name()}>` : `[<${a.name()}>${a.variadic ? "..." : ""}]`)).join(" ");
  const hasSub = cmd.commands.length > 0;
  return [[hasSub ? "<command>" : "", args, "[flags]"].filter(Boolean).join(" ")];
}

function defaultLearnMore(cmd) {
  const root = commandPath(cmd).split(" ")[0];
  const lines = [];
  if (cmd.commands.length) lines.push(`Use \`${commandPath(cmd)} <command> --help\` for more information about a command.`);
  lines.push(`Read the topics with \`${root} help <topic>\`: ${TOPIC_NAMES.join(", ")}.`);
  return lines;
}

// Attach gh-style metadata to a command. usage: array of strings (without the
// command path). examples: [{cmd, note}] where cmd omits nothing — it is the
// full command line as typed.
function gh(cmd, { usage, examples, learnMore } = {}) {
  if (usage) cmd._opsUsage = usage;
  if (examples) cmd._opsExamples = examples;
  if (learnMore) cmd._opsLearnMore = learnMore;
  return cmd;
}

// ---------------------------------------------------------------------------
// Help topics
// ---------------------------------------------------------------------------

const TOPICS = {
  environment: {
    summary: "Environment variables ops reads",
    text: `NO_COLOR: set to any value to disable colour on every stream.

OPS_PAGER, PAGER (in order of precedence): the pager \`ops orion script view\` pipes
through on a terminal. Default "less -FRX". Set to an empty string to disable.

OPS_ORION_SCRIPTS: absolute path of the Orion scripts directory. Takes precedence over
\`ops config get orion.scripts\` and over the default, the orion/ directory inside
the ops repo (where the scripts live).

OPS_CONFIG_DIR: directory holding config.json. Default $XDG_CONFIG_HOME/ops or
~/.config/ops.

OPS_STATE_DIR: directory holding the run records and logs that \`ops task ls\`
reads. Default $XDG_STATE_HOME/ops or ~/.local/state/ops; the newest 500 runs are
kept. Parameters passed with \`-p\` are recorded there in plain text, so do not pass a
secret that way — save it with \`ops secrets set\` or export it in your shell.

OPS_ENV_FILE: the file \`ops secrets\` reads and writes, and whose contents are put
into the environment of every run. Default .env in the ops repo, git-ignored and
mode 0600.

Scripts that talk to Invopop or Comarch read their token from the environment
(INVOPOP_API_TOKEN, INVOPOP_SANDBOX_API_TOKEN, COMARCH_UAT_JWT) and prompt for it
when unset. A script names the ones it needs in its frontmatter, and ops asks for
those once and passes them in — see \`ops help credentials\`. What you export always
wins over what ops holds.`,
  },
  "exit-codes": {
    summary: "Exit codes used by ops",
    text: `ops follows the same convention as the Orion scripts:

- 0  the command completed and, where it judges data, the data was fine
- 1  the command ran but found problems: doctor failures, docs check errors,
     drifted generated regions
- 2  the call was wrong: unknown command, bad flag, unknown script, a run
     refused before anything was spawned (doc-only runbook, missing exec bit)

\`ops run\` never adds a code of its own once the script has started:
the script's exit code is passed through verbatim, and 128 + signal number is
returned if the script was killed by a signal (130 after Ctrl-C).`,
  },
  credentials: {
    summary: "How ops holds the credentials the scripts need",
    text: `A script that talks to Invopop or Comarch reads its token from an environment
variable and prompts for it when the variable is unset. ops can save you that
prompt, and it does it by asking first rather than by watching the script:

- A script names what it needs as \`secrets:\` in its AGENTS.md frontmatter.
- Before a run, anything named there that is neither exported in your shell nor
  already saved is asked for, with the echo off, once.
- The answer goes into .env in the ops repo — git-ignored, mode 0600 — and into
  the environment of that run and every later one, so the script never asks.
- Skipping the prompt with Enter is always allowed: nothing is saved and the
  script asks for it the way it always has.

ops never takes a secret from a script's own prompt. \`ops run\` gives the script
your terminal and never reads what you type into it, and a captured log would
hold whatever the script echoed.

Precedence, lowest first: the .env file, then what your shell exported, then \`-p\`
parameters. So \`COMARCH_UAT_JWT=other ops run confirm_comarch_uat_queue\` is a
one-off with a different token, and \`ops run --no-secrets <script>\` hands the
script nothing and lets it ask.

WHEN ONE GOES STALE

A saved variable silences the script's own prompt, so a dead token would
otherwise turn a question into a 401. Three things stop that:

- A JWT carries its own expiry. ops reads it before the run, and an expired one
  is not passed: it says so and asks for a replacement.
- An opaque API token says nothing about itself, so ops cannot check it. When a
  run that was given one fails, ops names the secret it supplied and how old it
  is, and offers to replace it there and then. Answering no changes nothing —
  a run fails for many reasons and ops does not presume to know which.
- \`ops secrets set <name>\` replaces one at any time, and \`ops secrets unset
  <name>\` removes it so the script asks again.

WHAT IS NEVER WRITTEN DOWN

Values are never printed, never put in a run record and never sent anywhere.
\`ops secrets list\` shows names, where each would come from and how old it is. A
run record keeps the names of the secrets it was given, so \`ops task get\` can
tell you why a script did not prompt, and nothing more. Reports and captured
logs belong to the scripts: if a script echoes its own token, that is the
script's bug to fix.`,
  },
  tiers: {
    summary: "What the Orion danger tiers mean (and their colours)",
    text: `Every Orion script declares one \`tier\` in its AGENTS.md frontmatter: the worst
thing the script can do in any of its modes. Mode-by-mode nuance lives in the
script's own document (\`ops orion script view <name>\`).

- read-only               SELECTs and external GETs only. Cannot write anywhere.
                          Safe to automate with the script's own --yes / --json.
- prod-write              Writes production through gated Houston tasks. Dry run
                          by default, requires a terminal, confirmations before
                          each write, and the effect is reversible or idempotent.
- prod-write-irreversible Writes production and at least one step cannot be
                          undone (deregistering a supplier, rejecting documents).
- prod-write-no-dry-run   Writes production and the underlying task has nothing
                          to rehearse with — the first call writes.
- staging                 Writes a non-production target only: a staging
                          database, the Invopop sandbox, Comarch UAT. Refuses
                          production, and some of it deletes rows.

Wherever a tier is shown — the catalogue, a script's page, the line before a run,
the run history — it carries a colour: RED for anything that writes production,
yellow for staging, green for read-only. A
production write also says "PRODUCTION WRITE" in words, because a pipe keeps the
words and throws the colour away. A script's status is coloured too: green when it
is active, yellow when it is deprecated, a runbook or blocked.

Colour is off when the stream is not a terminal, or when NO_COLOR is set.

ops prints the tier on stderr before every run and adds no confirmation of its
own: the gates belong to the scripts.`,
  },
  conventions: {
    summary: "House rules every Orion script follows",
    text: `Layout      orion/<name>/ — one directory per script; env (production, staging)
            and access (read-only, write) are declared in its frontmatter. One
            executable entrypoint named after the directory (.js with #!/usr/bin/env node,
            .exs with #!/usr/bin/env elixir), and an AGENTS.md with frontmatter.
No wrappers Scripts run directly. ops only finds, documents and spawns them; it
            never changes their arguments, prompts or environment.
Safety      Writes require a terminal and the script asks before each one; dry
            run is the default; production takes extra confirmations. Read-only
            modes accept --yes and --json so an agent can report but never write.
Output      stdout is data, stderr is diagnostics. Colour only on a TTY with
            NO_COLOR unset: cyan for a query about to run, yellow for a command
            you could run yourself, bright white for headers, faint for progress.
            Reports are written to the current directory as
            <name>-<namespace>-<YYYY-MM-DD>.<ext>.
Exit codes  0 fine, 1 the data is wrong, 2 the call is wrong.
Prompting   One readline interface per process with a line queue — never open
            and close one per question (answers are lost on a piped stdin).
Tests       None. The oracle is a read-only run against a staging namespace.
Retiring    A script whose project is finished gets \`status: retired\` and a
            \`retired_reason\` in its frontmatter. It then disappears from the
            catalogue (\`ops orion script list --status retired\` shows it), \`ops run\`
            refuses it, and it keeps its own AGENTS.md as the record of what was
            done. The file itself still runs directly — that never changes.
Docs        The script's --help owns its flags. AGENTS.md frontmatter owns the
            summary, env, access, tier and examples. orion/AGENTS.md is generated by
            \`ops orion docs sync\` and checked by \`ops orion docs check\`.`,
  },
};
const TOPIC_NAMES = Object.keys(TOPICS).sort();

// ---------------------------------------------------------------------------
// Root program
// ---------------------------------------------------------------------------

function buildProgram() {
  const program = new OpsCommand("ops");
  program
    .summary("Personal operations toolbox")
    .description("Personal operations toolbox.")
    .version(pkg.version, "--version", "Show ops version")
    .helpOption("--help", "Show help for command")
    .helpCommand(false)
    .enablePositionalOptions()
    .showSuggestionAfterError(true)
    .exitOverride()
    .configureHelp({ helpWidth: Math.min(ui.width(), 100) });
  program.configureOutput({ writeErr: (s) => process.stderr.write(s) });

  gh(program, {
    usage: ["<command> [<subcommand>] [flags]", "run <script> [<script-args>...]"],
    examples: [
      { cmd: "ops run force_retry_invoices --dry-run 123,456", note: "run a script; the run is recorded" },
      { cmd: "ops task ls", note: "what has been run lately" },
      { cmd: "ops orion script list --env production --access write" },
      { cmd: "ops orion script view force_retry_invoices" },
    ],
    learnMore: ["Use `ops <command> --help` for more information about a command.", `Read the topics with \`ops help <topic>\`: ${TOPIC_NAMES.join(", ")}.`],
  });

  addHelpCommand(program);
  addConfigCommands(program);
  addSecretsCommands(program);
  addCompletionCommand(program);

  return program;
}

function shortHelp(program) {
  const helper = program.createHelp();
  helper.prepareContext({ helpWidth: Math.min(ui.width(), 100) });
  const termWidth = Math.max(
    0,
    ...helper.visibleCommands(program).map((s) => ui.displayWidth(`${s.name()}:`))
  );
  const out = [ui.section("USAGE", `  ops <command> [<subcommand>] [flags]`)];
  const groups = helper.groupItems(program.commands, helper.visibleCommands(program), (sub) => sub.helpGroup() || "COMMANDS");
  for (const [heading, cmds] of orderGroups(groups)) {
    out.push(ui.section(heading, cmds.map((s) => helper.formatItem(`${s.name()}:`, termWidth, s.summary() || s.description(), helper)).join("\n")));
  }
  out.push(`Run \`ops --help\` for flags and examples, \`ops interactive\` to browse and run from one screen.`);
  return out.join("\n\n") + "\n";
}

// `ops help [<command>...|<topic>]`
function addHelpCommand(program) {
  const help = program
    .command("help")
    .summary("Help about any command or topic")
    .description("Show help for a command path or one of the help topics.")
    .argument("[words...]", "command path (e.g. `run`) or a topic name")
    .helpGroup("CORE COMMANDS")
    .action((words) => {
      if (words.length === 0) return program.outputHelp();
      if (words.length === 1 && TOPICS[words[0]]) {
        const t = TOPICS[words[0]];
        process.stdout.write(`${c.header(words[0])} — ${t.summary}\n\n${t.text}\n`);
        return;
      }
      let cur = program;
      for (const w of words) {
        const next = cur.commands.find((s) => s.name() === w);
        if (!next) throw new UsageError(`unknown help topic or command: ${words.join(" ")}`, `Topics: ${TOPIC_NAMES.join(", ")}. Commands: \`ops --help\`.`);
        cur = next;
      }
      cur.outputHelp();
    });
  gh(help, {
    usage: ["[<command>...]", "<topic>"],
    examples: [{ cmd: "ops help run" }, { cmd: "ops help tiers" }],
    learnMore: [`Topics: ${TOPIC_NAMES.join(", ")}.`],
  });
  // Topics appear in the root help as their own group; they are hidden commands
  // so commander's suggestion engine knows them.
  for (const [name, t] of Object.entries(TOPICS)) {
    program
      .command(name, { hidden: false })
      .summary(t.summary)
      .helpGroup("HELP TOPICS")
      .action(() => process.stdout.write(`${c.header(name)} — ${t.summary}\n\n${t.text}\n`));
  }
}

function addConfigCommands(program) {
  const cfg = program.command("config").summary("Manage configuration for ops").description(`Read and write ${config.CONFIG_FILE}.\n\nKeys are dotted paths. Known keys:\n  orion.scripts     absolute path of the Orion scripts directory\n  interactive.bare  true to open \`ops interactive\` for a bare \`ops\` on a terminal`).helpGroup("CORE COMMANDS");
  gh(cfg, { examples: [{ cmd: "ops config set orion.scripts /path/to/another/orion" }, { cmd: "ops config set interactive.bare true" }, { cmd: "ops config get orion.scripts" }, { cmd: "ops config list" }] });

  cfg
    .command("get")
    .summary("Print the value of a given configuration key")
    .argument("<key>")
    .action((key) => {
      const v = config.get(key);
      if (v === undefined) throw new ProblemsExit(`no value set for ${key}`);
      process.stdout.write((typeof v === "string" ? v : JSON.stringify(v)) + "\n");
    });
  cfg
    .command("set")
    .summary("Update configuration with a value for the given key")
    .argument("<key>")
    .argument("<value>")
    .action((key, value) => {
      config.set(key, value);
    });
  cfg
    .command("unset")
    .summary("Remove a configuration key")
    .argument("<key>")
    .action((key) => {
      if (!config.unset(key)) throw new ProblemsExit(`no value set for ${key}`);
    });
  cfg
    .command("list")
    .summary("Print a list of configuration keys and values")
    .action(() => {
      const rows = config.entries();
      process.stdout.write(rows.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n") + (rows.length ? "\n" : ""));
    });
}


function addSecretsCommands(program) {
  const secrets = require("./secrets");

  const grp = program
    .command("secrets")
    .summary("Manage the credentials ops passes to a run")
    .description(`Read and write ${secrets.FILE}, the git-ignored file (mode 0600) whose contents ops puts into the environment of every script it runs.\n\nA script that reads a token from the environment and prompts when it is unset stops prompting once the token is here. A script declares the ones it needs as \`secrets:\` in its AGENTS.md frontmatter; \`ops run\` asks for those before the run and saves the answer, so the asking happens once.\n\nValues are never printed, never written to a run record and never sent anywhere: \`list\` shows names, where each one comes from and how old it is.\n\nWhat your shell exported always wins over this file, so \`TOKEN=other ops run …\` is still a one-off.`)
    .helpGroup("CORE COMMANDS")
    .enablePositionalOptions();
  gh(grp, {
    examples: [
      { cmd: "ops secrets list" },
      { cmd: "ops secrets set INVOPOP_API_TOKEN", note: "prompts with the echo off — keeps it out of your shell history" },
      { cmd: "ops secrets unset COMARCH_UAT_JWT", note: "the script goes back to asking for it" },
    ],
    learnMore: ["Read `ops help credentials` for the whole picture, including what expires and when."],
  });

  const ls = grp
    .command("list")
    .summary("List the secrets ops holds, by name")
    .description("List every name in the file: where the value would come from for a run, when it was saved, and — for a JWT, which says so itself — when it expires.\n\nValues are never shown. A name also exported in your shell is marked, because your export is what a run would get.")
    .option("--json", "output JSON instead of a table")
    .action((opts) => {
      const file = secrets.load();
      const rows = Object.keys(file)
        .sort()
        .map((name) => {
          const exp = secrets.jwtExpiry(file[name]);
          return {
            name,
            source: process.env[name] !== undefined ? "environment" : "file",
            saved_at: secrets.savedAt(name)?.toISOString().slice(0, 10) ?? null,
            expires_at: exp ? exp.toISOString() : null,
            expired: exp ? exp.getTime() <= Date.now() : false,
          };
        });
      if (opts.json) return process.stdout.write(ui.json(rows));
      if (!rows.length) {
        if (process.stdout.isTTY) ui.eprint(c.faint(`nothing saved yet — ${secrets.FILE} does not exist`));
        return;
      }
      const cell = (r) => [
        r.name,
        r.source === "environment" ? (process.stdout.isTTY ? c.warn("environment") : "environment") : "file",
        r.saved_at ?? (process.stdout.isTTY ? c.faint("-") : ""),
        r.expires_at === null ? (process.stdout.isTTY ? c.faint("-") : "") : process.stdout.isTTY ? (r.expired ? c.bad(r.expires_at.slice(0, 10)) : c.ok(r.expires_at.slice(0, 10))) : r.expires_at.slice(0, 10),
      ];
      process.stdout.write(ui.table(rows.map(cell), ["NAME", "SOURCE", "SAVED", "EXPIRES"]));
      const m = secrets.mode();
      if (m && m !== "0600" && process.stdout.isTTY) ui.eprint(cerrWarn(`${secrets.FILE} is mode ${m} — it holds credentials; chmod 600 it`));
    });
  gh(ls, { usage: ["[flags]"], examples: [{ cmd: "ops secrets list" }, { cmd: "ops secrets list --json | jq -r '.[] | select(.expired) | .name'" }] });

  const set = grp
    .command("set")
    .summary("Save a secret, replacing any value already held")
    .description("Save a value under a name, replacing whatever was there. With no value on the command line it is prompted for with the echo off, which is the form to use: an argument would sit in your shell history.\n\nThe file is created with mode 0600 and is git-ignored.")
    .argument("<name>", "environment variable name, e.g. INVOPOP_API_TOKEN")
    .argument("[value]", "the value; prompted for when left out")
    .action(async (name, value) => {
      secrets.checkName(name);
      let v = value;
      if (v === undefined) {
        if (!process.stdin.isTTY) throw new UsageError("no value given and no terminal to ask on", `pipe nothing, or pass it: \`ops secrets set ${name} <value>\``);
        v = await secrets.ask(`${name}: `);
        if (v === null) throw new UsageError("nothing entered", "run it again when you have the value");
      }
      secrets.set(name, v);
      ui.eprint(`${c.ok("saved")} ${name} → ${secrets.FILE}`);
    });
  gh(set, { usage: ["<name> [<value>]"], examples: [{ cmd: "ops secrets set INVOPOP_API_TOKEN", note: "prompts, echo off" }] });

  const rm = grp
    .command("unset")
    .summary("Remove a secret, so the script asks for it again")
    .description("Remove a name from the file. The next run of a script that needs it will ask for it again — which is also the way to deal with one that has gone stale.")
    .argument("<name>")
    .action((name) => {
      if (!secrets.unset(name)) throw new ProblemsExit(`no secret named ${name}`);
      ui.eprint(`${c.ok("removed")} ${name}`);
    });
  gh(rm, { usage: ["<name>"], examples: [{ cmd: "ops secrets unset COMARCH_UAT_JWT" }] });

  const where = grp
    .command("path")
    .summary("Print the path of the secrets file")
    .description("Print the absolute path of the file and nothing else, whether or not it exists yet.")
    .action(() => process.stdout.write(secrets.FILE + "\n"));
  gh(where, { usage: [""], examples: [{ cmd: "ops secrets path" }, { cmd: "chmod 600 \"$(ops secrets path)\"" }] });
}

function cerrWarn(msg) {
  return `${ui.cerr.warn("warning:")} ${msg}`;
}

function addCompletionCommand(program) {
  const completion = program
    .command("completion")
    .summary("Generate the zsh completion script")
    .description("Generate a shell completion script for ops. Only zsh is supported.\n\nInstall it with:\n\n  mkdir -p ~/.zfunc && ops completion zsh > ~/.zfunc/_ops\n\nand make sure ~/.zfunc is on your fpath before compinit runs:\n\n  fpath=(~/.zfunc $fpath)")
    .argument("<shell>", "zsh")
    .helpGroup("CORE COMMANDS")
    .action((shell) => {
      if (shell !== "zsh") throw new UsageError(`unsupported shell: ${shell}`, "only zsh is supported");
      process.stdout.write(zshCompletion(program));
    });
  gh(completion, { usage: ["zsh"], examples: [{ cmd: "ops completion zsh > ~/.zfunc/_ops" }] });
}

// A static _ops completion file generated from the command tree.
function zshCompletion(program) {
  const lines = ["#compdef ops", "# generated by `ops completion zsh`", "", "_ops() {", "  local -a cmds", "  local curcontext=\"$curcontext\" state line", "  typeset -A opt_args", "  _arguments -C '1: :->cmd' '*:: :->args'", "  case $state in", "    cmd)"];
  const top = program.commands.filter((s) => s.helpGroup() !== "HELP TOPICS");
  lines.push("      cmds=(" + top.map((s) => `'${s.name()}:${esc(s.summary() || "")}'`).join(" ") + " " + Object.keys(TOPICS).map((t) => `'${t}:${esc(TOPICS[t].summary)}'`).join(" ") + ")");
  lines.push("      _describe 'command' cmds ;;", "    args)", "      case $line[1] in");
  for (const sub of top) lines.push(...completeSubtree(sub, "        "));
  lines.push("      esac ;;", "  esac", "}", "", "_ops \"$@\"");
  return lines.join("\n") + "\n";
}

function esc(s) {
  return s.replace(/'/g, "'\\''").replace(/:/g, "\\:");
}

// Completion for one command's own subtree (subcommands, then flags).
function completeSubtree(cmd, indent) {
  const out = [`${indent}${cmd.name()})`];
  if (cmd.commands.length) {
    const subs = cmd.commands.map((s) => `'${s.name()}:${esc(s.summary() || "")}'`).join(" ");
    out.push(`${indent}  if (( CURRENT == 2 )); then cmds=(${subs}); _describe 'subcommand' cmds; else`, `${indent}    case $words[2] in`);
    for (const s of cmd.commands) out.push(...completeSubtree(s, indent + "      ").map((l, i) => (i === 0 ? l : l)));
    out.push(`${indent}    esac`, `${indent}  fi ;;`);
  } else {
    const flags = cmd.options.map((o) => o.long).filter(Boolean);
    const dyn = cmd._opsComplete ? ` && ${cmd._opsComplete}` : "";
    out.push(`${indent}  local -a flags; flags=(${flags.map((f) => `'${f}'`).join(" ")}); compadd -a flags${dyn} ;;`);
  }
  return out;
}

// A "problem" exit (1) raised from an action.
class ProblemsExit extends ui.ProblemsError {}

module.exports = { buildProgram, OpsCommand, gh, shortHelp, TOPICS, TOPIC_NAMES, GhHelp, commandPath, ProblemsExit };
