"use strict";

// Scaffold templates for `ops orion script new`. {{var}} placeholders.

const AGENTS = `---
name: {{name}}
summary: {{summary}}
env: {{env}}
access: {{access}}
tier: {{tier}}
lang: {{lang}}
examples:
  - args: "--help"
    note: show the script's flags
---
# {{name}}

One paragraph: what question this script answers or what it changes, and why it
exists. Flags live in the script's own \`--help\`; do not repeat them here.

## What it does

1. Read — which databases / APIs, read-only.
2. Decide — the rule the script applies.
3. Write — which Houston task or API call, and how it is gated.

## Safety

- Dry run is the default; \`--apply\` (or the prompt) is needed to write.
- Writes require a terminal; nothing writes on a piped stdin.
- Every statement / command is echoed before it runs.
- Production takes an extra confirmation (type the namespace back).

## Prereqs

- VPN up, \`houston\` authenticated.
- Secrets: none / \`SOME_TOKEN\` from the shell environment (prompted when unset).

## Output

- \`{{name}}-<namespace>-<YYYY-MM-DD>.md\` in the current directory.
- Exit 0 fine, 1 the data is wrong, 2 the call is wrong.
`;

const JS = `#!/usr/bin/env node
"use strict";

// {{name}} — {{summary}}
//
// Self-contained on purpose: one directory, one entrypoint, no shared library.
// Copy helpers from a sibling script rather than importing them.

const { spawnSync } = require("child_process");
const readline = require("readline/promises");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code) => (s) => (COLOR ? \`\\x1b[\${code}m\${s}\\x1b[0m\`: String(s));
const c = { header: sgr("1;37"), cmd: sgr("33"), sql: sgr("36"), faint: sgr("2"), ok: sgr("32"), bad: sgr("31") };

function usage() {
  return \`{{name}} — {{summary}}

Usage:
  ./{{name}}.js [flags] <ids>

Arguments:
  ids                    Comma-separated ids

Flags:
  -n, --namespace NAME   target namespace (default: {{defaultNamespace}})
      --dry-run          plan only, write nothing (default)
      --apply            actually write
  -y, --yes              approve READS without prompting (read-only paths only)
  -h, --help             show this help
\`;
}

function parseArgs(argv) {
  const o = { namespace: "{{defaultNamespace}}", apply: false, yes: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { process.stdout.write(usage()); process.exit(0); }
    else if (a === "-n" || a === "--namespace") o.namespace = argv[++i];
    else if (a === "--dry-run") o.apply = false;
    else if (a === "--apply") o.apply = true;
    else if (a === "-y" || a === "--yes") o.yes = true;
    else if (a.startsWith("-")) { process.stderr.write(\`unknown flag \${a}\\n\${usage()}\`); process.exit(2); }
    else o.positional.push(a);
  }
  return o;
}

// One readline interface for the whole run: opening one per question loses
// answers on a piped stdin.
let rl = null;
function ensureRl() {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return rl;
}
async function ask(q) {
  return (await ensureRl().question(q)).trim();
}
function closeRl() {
  if (rl) rl.close();
}

function psqlRead(env, db, sql) {
  process.stderr.write(c.sql(\`-- [\${env}/\${db}] \${sql}\\n\`));
  const r = spawnSync("houston", ["psql", env, db, "--", "-t", "-A", "-F", "|", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || \`psql exited \${r.status}\`);
  return r.stdout;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.apply && !process.stdin.isTTY) {
    process.stderr.write("writes require a terminal\\n");
    return 2;
  }
  // TODO: read, decide, (maybe) write.
  process.stdout.write(c.header("{{name}}") + \` — namespace \${opts.namespace}, \${opts.apply ? "APPLY" : "dry run"}\\n\`);
  return 0;
}

main()
  .then((code) => { closeRl(); process.exit(code); })
  .catch((err) => { closeRl(); process.stderr.write(c.bad(\`error: \${err.message}\\n\`)); process.exit(1); });
`;

const EXS = `#!/usr/bin/env elixir

# {{name}} — {{summary}}
#
# Self-contained on purpose: one directory, one entrypoint, no shared library.

Mix.install([])

defmodule Script do
  @usage """
  {{name}} — {{summary}}

  Usage:
    ./{{name}}.exs [flags] <ids>

  Flags:
    -n, --namespace NAME   target namespace (default: {{defaultNamespace}})
        --dry-run          plan only, write nothing (default)
        --apply            actually write
    -h, --help             show this help
  """

  def main(argv) do
    {opts, positional, invalid} =
      OptionParser.parse(argv,
        strict: [namespace: :string, dry_run: :boolean, apply: :boolean, help: :boolean],
        aliases: [n: :namespace, h: :help]
      )

    cond do
      opts[:help] -> IO.write(@usage); System.halt(0)
      invalid != [] -> IO.write(:stderr, "unknown flags: #{inspect(invalid)}\\n" <> @usage); System.halt(2)
      true -> run(Keyword.merge([namespace: "{{defaultNamespace}}", apply: false], opts), positional)
    end
  end

  defp run(opts, _positional) do
    IO.puts("{{name}} — namespace #{opts[:namespace]}, #{if opts[:apply], do: "APPLY", else: "dry run"}")
    # TODO: read, decide, (maybe) write.
    System.halt(0)
  end
end

Script.main(System.argv())
`;

function fill(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`template: no value for ${k}`);
    return vars[k];
  });
}

module.exports = { AGENTS, JS, EXS, fill };
