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
//     ops orion script run <script> [<script-args>...]
//
//   ALIASES / <COMMAND GROUPS> / FLAGS / INHERITED FLAGS / EXAMPLES / LEARN MORE
// ---------------------------------------------------------------------------

function commandPath(cmd) {
  const parts = [];
  for (let cur = cmd; cur; cur = cur.parent) parts.unshift(cur.name());
  return parts.join(" ");
}

class GhHelp extends Help {
  formatHelp(cmd, helper) {
    const termWidth = helper.padWidth(cmd, helper);
    const item = (term, desc) => helper.formatItem(term, termWidth, desc, helper);
    const sections = [];

    const long = cmd.description() || cmd.summary() || "";
    if (long) sections.push(ui.wrap(long, helper.helpWidth ?? 80));

    const usage = cmd._opsUsage ?? defaultUsage(cmd);
    sections.push(ui.section("USAGE", usage.map((u) => `  ${commandPath(cmd)} ${u}`.trimEnd()).join("\n")));

    if (cmd.aliases().length) {
      const parent = cmd.parent ? commandPath(cmd.parent) + " " : "";
      sections.push(ui.section("ALIASES", cmd.aliases().map((a) => `  ${parent}${a}`).join("\n")));
    }

    const groups = this.groupItems(cmd.commands, helper.visibleCommands(cmd), (sub) => sub.helpGroup() || "COMMANDS");
    for (const [heading, cmds] of groups) {
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

Scripts that talk to Invopop or Comarch read their token from your shell
environment (INVOPOP_API_TOKEN, INVOPOP_SANDBOX_API_TOKEN, COMARCH_UAT_JWT) and
prompt for it when unset. ops never reads or forwards those.
  },
  "exit-codes": {
    summary: "Exit codes used by ops",
    text: `ops follows the same convention as the Orion scripts:

- 0  the command completed and, where it judges data, the data was fine
- 1  the command ran but found problems: doctor failures, docs check errors,
     drifted generated regions
- 2  the call was wrong: unknown command, bad flag, unknown script, a run
     refused before anything was spawned (doc-only runbook, missing exec bit)

\`ops orion script run\` never adds a code of its own once the script has started:
the script's exit code is passed through verbatim, and 128 + signal number is
returned if the script was killed by a signal (130 after Ctrl-C).`,
  },
  tiers: {
    summary: "What the Orion danger tiers mean",
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
- sandbox                 Writes an external non-production system (Invopop
                          sandbox, Comarch UAT). Refuses production credentials.
- staging-destructive     Deletes rows in a staging database. Refuses production
                          namespaces.

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
Docs        The script's --help owns its flags. AGENTS.md frontmatter owns the
            summary, env, access, tier, aliases and examples. orion/AGENTS.md is generated by
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
    usage: ["<group> <command> [<subcommand>] [flags]"],
    examples: [
      { cmd: "ops orion script list --env production --access write" },
      { cmd: "ops orion script view retry_invoices" },
      { cmd: "ops orion script run retry_invoices --dry-run 123,456" },
      { cmd: "ops alias set osr 'orion script run' && ops osr ri --dry-run 123,456" },
    ],
    learnMore: ["Use `ops <group> <command> --help` for more information about a command.", `Read the topics with \`ops help <topic>\`: ${TOPIC_NAMES.join(", ")}.`],
  });

  addHelpCommand(program);
  addConfigCommands(program);
  addAliasCommands(program);
  addCompletionCommand(program);

  return program;
}

function shortHelp(program) {
  const helper = program.createHelp();
  helper.prepareContext({ helpWidth: Math.min(ui.width(), 100) });
  const termWidth = helper.padWidth(program, helper);
  const out = [ui.section("USAGE", `  ops <group> <command> [<subcommand>] [flags]`)];
  const groups = helper.groupItems(program.commands, helper.visibleCommands(program), (sub) => sub.helpGroup() || "COMMANDS");
  for (const [heading, cmds] of groups) {
    out.push(ui.section(heading, cmds.map((s) => helper.formatItem(`${s.name()}:`, termWidth, s.summary() || s.description(), helper)).join("\n")));
  }
  out.push(`Run \`ops --help\` for flags and examples, \`ops orion script pick\` to browse interactively.`);
  return out.join("\n\n") + "\n";
}

// `ops help [<command>...|<topic>]`
function addHelpCommand(program) {
  const help = program
    .command("help")
    .summary("Help about any command or topic")
    .description("Show help for a command path or one of the help topics.")
    .argument("[words...]", "command path (e.g. `orion script run`) or a topic name")
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
        const next = cur.commands.find((s) => s.name() === w || s.aliases().includes(w));
        if (!next) throw new UsageError(`unknown help topic or command: ${words.join(" ")}`, `Topics: ${TOPIC_NAMES.join(", ")}. Commands: \`ops --help\`.`);
        cur = next;
      }
      cur.outputHelp();
    });
  gh(help, {
    usage: ["[<command>...]", "<topic>"],
    examples: [{ cmd: "ops help orion script run" }, { cmd: "ops help tiers" }],
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
  const cfg = program.command("config").summary("Manage configuration for ops").description(`Read and write ${config.CONFIG_FILE}.\n\nKeys are dotted paths. Known keys:\n  orion.scripts   absolute path of the Orion scripts directory`).helpGroup("CORE COMMANDS");
  gh(cfg, { examples: [{ cmd: "ops config set orion.scripts /path/to/another/orion" }, { cmd: "ops config get orion.scripts" }, { cmd: "ops config list" }] });

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
      if (key.startsWith("aliases.")) throw new UsageError("use `ops alias set` for aliases");
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
      const rows = config.entries().filter(([k]) => !k.startsWith("aliases."));
      process.stdout.write(rows.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n") + (rows.length ? "\n" : ""));
    });
}

function addAliasCommands(program) {
  const alias = program
    .command("alias")
    .summary("Create command shortcuts")
    .description("Aliases expand the first word of an ops invocation into several: `ops alias set osr 'orion script run'` makes `ops osr ri --dry-run 1` run `ops orion script run ri --dry-run 1`. An alias can never shadow a real command or topic.")
    .helpGroup("CORE COMMANDS");
  gh(alias, { examples: [{ cmd: "ops alias set osr 'orion script run'" }, { cmd: "ops alias set ol 'orion script list'" }, { cmd: "ops alias list" }] });

  alias
    .command("set")
    .summary("Create a shortcut for an ops command")
    .argument("<alias>")
    .argument("<expansion>", "quoted command words, without the leading `ops`")
    .action((name, expansion) => {
      if (reservedWords(program).has(name)) throw new UsageError(`"${name}" is a command or topic name and cannot be an alias`);
      if (!/^[a-z][a-z0-9_-]{0,15}$/.test(name)) throw new UsageError("alias names are lowercase letters, digits, - and _, starting with a letter");
      const words = expansion.trim().split(/\s+/);
      if (words[0] === "ops") words.shift();
      if (!words.length || !program.commands.some((s) => s.name() === words[0])) throw new UsageError(`expansion must start with an ops command, got "${expansion}"`);
      config.set(`aliases.${name}`, words.join(" "));
      ui.eprint(`- Added alias ${name}`);
    });
  alias
    .command("list")
    .summary("List your aliases")
    .action(() => {
      const rows = Object.entries(config.aliases()).sort();
      process.stdout.write(ui.table(rows.map(([k, v]) => [k, v]), ["ALIAS", "EXPANSION"]));
    });
  alias
    .command("delete")
    .summary("Delete an alias")
    .argument("<alias>")
    .action((name) => {
      if (!config.unset(`aliases.${name}`)) throw new ProblemsExit(`no such alias: ${name}`);
      ui.eprint(`- Deleted alias ${name}`);
    });
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

// Every word that can never be an alias: commands, their aliases, topics.
function reservedWords(program) {
  const s = new Set(TOPIC_NAMES);
  for (const sub of program.commands) {
    s.add(sub.name());
    for (const a of sub.aliases()) s.add(a);
  }
  return s;
}

// A "problem" exit (1) raised from an action.
class ProblemsExit extends ui.ProblemsError {}

module.exports = { buildProgram, OpsCommand, gh, shortHelp, reservedWords, TOPICS, TOPIC_NAMES, GhHelp, commandPath, ProblemsExit };
