# ops

Personal operations toolbox: a `gh`-style CLI plus the operational scripts it
runs. The first group, `orion`, browses, documents and runs the scripts in
[`orion/`](orion/) (formerly the `einvoicing-scripts` repo, moved here with its
history) and keeps their catalogue generated.

```
ops <command> [<subcommand>] [flags]

ops run <name> [args...]                  run a script; the run gets an id, a status and a log
ops task ls                               past runs, newest first (--script --status --param --since)
ops task get  <id>                        one run's record, with the tail of its log
ops task logs <id>                        everything that run printed
ops task rerun <id>                       same script, same arguments, new id
ops task cancel <id>                      stop one that is still going

ops orion script list                     catalogue: env · access · tier · status · summary
ops orion script view <name>              doc page + the script's live --help + examples
ops orion script pick                     interactive picker (TTY only)
ops orion script new  <name> --lang {js|exs} --env … --access …
ops orion doctor                          runtimes, houston, catalogue
ops orion docs check | sync               lint the catalogue / regenerate the root tables
ops alias set osr 'orion script run'      shortcuts, gh-style
ops help tiers | environment | exit-codes | conventions
```

## Install

```sh
git clone <this repo> ~/Desktop/repos/ops
cd ~/Desktop/repos/ops && npm ci
echo 'export PATH="$HOME/Desktop/repos/ops/bin:$PATH"' >> ~/.zshrc && exec zsh
ops orion doctor
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

$ ops orion task run ri --dry-run 123,456
ops ▸ run 42  retry_invoices (alias ri)  production · write · prod-write — Prod writes (gated, reversible-ish)
…the script's own prompts, gates and output…
ops ▸ run 42 completed in 18s (exit 0)  · ops orion task logs 42

$ ops orion task ls --script ri
ID  STATUS     SCRIPT          STARTED    DURATION  ARGS
42  completed  retry_invoices  2m ago     18s       --dry-run 123,456
41  failed     retry_invoices  yesterday  4s        999
```

Runs are modelled on `houston task`: `run`, `ls`, `get`, `logs`, `rerun`, `cancel`,
`-p KEY=VALUE` parameters, newest-first listings and the same `KEY=VALUE` /
`KEY~VALUE` parameter filters. `ops orion script run` is the older spelling of
`ops orion task run` and goes through the same path.

`ops` never adds or removes a confirmation: the scripts own their safety gates.
The one line on stderr before a run is the script's environment, access and tier.

## Where things come from

| Shown by `ops` | Source of truth |
|---|---|
| summary, env, access, tier, status, aliases, examples, report globs | frontmatter at the top of the script's `AGENTS.md` |
| DESCRIPTION | the `What it does` / `Pipeline` / `Safety` / `Prereqs` / `Output` sections of that `AGENTS.md` |
| SCRIPT HELP (flags) | the script's own `--help`, run live for Node scripts |
| `orion/AGENTS.md` tables, `orion/.gitignore` report globs | generated between `ops:begin` / `ops:end` markers by `ops orion docs sync` |

## Layout

```
orion/                  the scripts: one <name>/ per script with an AGENTS.md each; .tool-versions
bin/ops                 entry: builds the commander program, expands aliases, maps errors to exit codes
lib/program.js          root program, gh-style help formatter, help topics, config / alias / completion
lib/ui.js               colour (NO_COLOR), TTY vs TSV tables, JSON, wrap, pager, error classes
lib/config.js           ~/.config/ops/config.json
lib/orion/index.js      registers `ops orion`
lib/orion/catalogue.js  frontmatter parser (strict YAML subset), dir walk, validation, name/alias resolution
lib/orion/{list,view,run,pick,new,doctor,docs}.js
lib/orion/task.js       the run lifecycle: run / ls / get / logs / rerun / cancel
lib/orion/runs.js       the run store under $OPS_STATE_DIR (record + log per run)
lib/orion/templates.js  scaffold strings for `script new`
docs/help-text-style.md the gh conventions every help page and summary follows
docs/adding-a-group.md  how to add `ops <group>`
```

Exit codes: 0 fine, 1 problems found (doctor, docs check), 2 the call was wrong.
`ops orion script run` passes the script's exit code through verbatim.
