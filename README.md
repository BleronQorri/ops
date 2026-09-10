# ops

Personal operations toolbox: a `gh`-style CLI plus the operational scripts it
runs. The first group, `orion`, browses, documents and runs the scripts in
[`orion/`](orion/) (formerly the `einvoicing-scripts` repo, moved here with its
history) and keeps their catalogue generated.

```
ops <group> <command> [<subcommand>] [flags]

ops orion script list                     catalogue: env · access · tier · status · summary
ops orion script view <name>              doc page + the script's live --help + examples
ops orion script run  <name> [args...]    runs the file exactly as if you typed its path
ops orion script pick                     interactive picker (TTY only)
ops orion script new  <env>/<access>/<name> --lang {js|exs}
ops orion doctor [--fix]                  runtimes, .env secrets, houston, catalogue
ops orion docs check | sync               lint the catalogue / regenerate the root tables
ops alias set osr 'orion script run'      shortcuts, gh-style
ops help tiers | environment | exit-codes | conventions
```

## Install

```sh
git clone <this repo> ~/Desktop/repos/ops
cd ~/Desktop/repos/ops && npm ci
echo 'export PATH="$HOME/Desktop/repos/ops/bin:$PATH"' >> ~/.zshrc && exec zsh
ops orion doctor --fix
```

Node ≥ 20. The only dependency is [commander](https://github.com/tj/commander.js).

The scripts live in `orion/` in this repo and are found there by default. To point
`ops` at another checkout use `OPS_ORION_SCRIPTS` or:

```sh
ops config set orion.scripts /path/to/another/orion
```

Zsh completion (optional):

```sh
mkdir -p ~/.zfunc && ops completion zsh > ~/.zfunc/_ops
# in ~/.zshrc, before compinit:  fpath=(~/.zfunc $fpath)
```

## A session

```
$ ops orion script list --env production --access write
NAME                             ENV         ACCESS  TIER                     STATUS   SUMMARY
b2b_credit_notes                 production  write   read-only                active   Map each B2B credit note to the invoice it credits, …
fix_credit_note_references       production  write   prod-write               blocked  Phase 2 of b2b_credit_notes: put the BillingReference …
retry_invoices                   production  write   prod-write               active   Re-drive stuck KSA e-invoices: flip trackers retry-eligible, …

$ ops orion script view ri          # the page: summary, tier, key AGENTS.md sections, live --help, examples
$ ops orion script run ri --dry-run 123,456
ops ▸ retry_invoices (alias ri)  production · write · prod-write — Prod writes (gated, reversible-ish)
…the script's own prompts, gates and output…
```

`ops` never adds or removes a confirmation: the scripts own their safety gates.
The one line on stderr before a run is the script's environment, access and tier.

## Where things come from

| Shown by `ops` | Source of truth |
|---|---|
| summary, tier, status, aliases, examples, env vars, report globs | frontmatter at the top of the script's `AGENTS.md` |
| DESCRIPTION | the `What it does` / `Pipeline` / `Safety` / `Prereqs` / `Output` sections of that `AGENTS.md` |
| SCRIPT HELP (flags) | the script's own `--help`, run live for Node scripts |
| `orion/AGENTS.md` tables, `orion/README.md` catalogue, `orion/.gitignore` report globs | generated between `ops:begin` / `ops:end` markers by `ops orion docs sync` |

## Layout

```
orion/                  the scripts: <env>/<access>/<name>/ with an AGENTS.md each, .env.example, .tool-versions
bin/ops                 entry: builds the commander program, expands aliases, maps errors to exit codes
lib/program.js          root program, gh-style help formatter, help topics, config / alias / completion
lib/ui.js               colour (NO_COLOR), TTY vs TSV tables, JSON, wrap, pager, error classes
lib/config.js           ~/.config/ops/config.json
lib/orion/index.js      registers `ops orion`
lib/orion/catalogue.js  frontmatter parser (strict YAML subset), dir walk, validation, name/alias resolution
lib/orion/{list,view,run,pick,new,doctor,docs}.js
lib/orion/templates.js  scaffold strings for `script new`
docs/help-text-style.md the gh conventions every help page and summary follows
docs/adding-a-group.md  how to add `ops <group>`
```

Exit codes: 0 fine, 1 problems found (doctor, docs check), 2 the call was wrong.
`ops orion script run` passes the script's exit code through verbatim.
