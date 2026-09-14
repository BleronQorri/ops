# ops

Personal operations toolbox: a `gh`-style CLI plus the operational scripts it
runs. The first group, `orion`, browses, documents and runs the scripts in
[`orion/`](orion/) (formerly the `einvoicing-scripts` repo, moved here with its
history) and keeps their catalogue generated.

```
ops <command> [<subcommand>] [flags]

ops interactive                           scripts and runs on one screen; act on either (TTY only)
ops run <name> [args...]                  run a script; the run gets an id, a status and a log
ops task ls                               past runs, newest first (--script --status --param --since)
ops task get  <id>                        one run's record, with the tail of its log
ops task logs <id>                        everything that run printed
ops task rerun <id>                       same script, same arguments, new id
ops task cancel <id>                      stop one that is still going

ops orion script list                     catalogue: a section per domain, a table per environment
ops orion script list --country SA        one tax authority's tools (--integration, --integrator, --domain)
ops orion script list --status retired    the decommissioned ones, hidden by default
ops orion script view <name>              doc page + the script's live --help + examples
ops orion script pick                     pick one script and leave (TTY only)
ops orion script new  <name> --lang {js|exs} --env … --access …
ops secrets list                          the credentials ops holds, by name (never values)
ops secrets set <NAME>                    save one; prompts with the echo off
ops secrets unset <NAME>                  drop one, so the script asks for it again

ops orion doctor                          runtimes, houston, catalogue
ops orion docs check | sync               lint the catalogue / regenerate the root tables
ops help tiers | credentials | environment | exit-codes | conventions
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

A bare `ops` prints the short help, the way `gh` does. To have it open the
interactive screen on a terminal instead:

```sh
ops config set interactive.bare true
```

## A session

```
$ ops interactive                  # ↑↓ move · enter run · v view · tab runs · / filter · ? keys
ops ▸ scripts  ↑↓ move · enter run · v view · d doc · t show retired · tab runs · / filter · ? keys · q quit
/ to filter
  PRODUCTION  7 scripts
❯ check_invopop_suppliers          read-only    List Invopop supplier silo entries and flag …
  force_retry_invoices            prod-write   Re-drive stuck KSA e-invoices: flip trackers …
  STAGING  3 scripts
  wipe_provider_einvoicing         staging      Wipe all of a provider's e-invoicing rows …

$ ops orion script list --env production --access write
NAME                             ENV         ACCESS  TIER                     STATUS   SUMMARY
match_credit_notes_to_invoices                 production  write   read-only                active   Map each B2B credit note to the invoice it credits, …
fix_credit_note_references       production  write   prod-write               blocked  Phase 2 of match_credit_notes_to_invoices: put the BillingReference …
force_retry_invoices                   production  write   prod-write               active   Re-drive stuck KSA e-invoices: flip trackers retry-eligible, …

$ ops orion script view force_retry_invoices          # the page: summary, tier, key AGENTS.md sections, live --help, examples

$ ops task run force_retry_invoices --dry-run 123,456
ops ▸ run 42  force_retry_invoices  ⚠ PRODUCTION WRITE  production · write · prod-write — …
…the script's own prompts, gates and output…
ops ▸ run 42 completed in 18s (exit 0)  · ops task logs 42

$ ops task ls --script force_retry_invoices
ID  STATUS     SCRIPT          STARTED    DURATION  ARGS
42  completed  force_retry_invoices  2m ago     18s       --dry-run 123,456
41  failed     force_retry_invoices  yesterday  4s        999
```

Runs are modelled on `houston task`: `run`, `ls`, `get`, `logs`, `rerun`, `cancel`,
`-p KEY=VALUE` parameters, newest-first listings and the same `KEY=VALUE` /
`KEY~VALUE` parameter filters. `ops run <script>` and `ops task run <script>` are
the same command registered twice, and go through the same path.

`ops` never adds or removes a confirmation: the scripts own their safety gates.
The one line on stderr before a run is the script's environment, access and tier.

## Domains and countries

The catalogue groups by `domain` before environment: `e-invoicing` for anything
that talks to a tax authority or to the documents on their way to one, and
`accounting-documents` for the documents themselves. An e-invoicing script also
names the country it serves, the scheme that country runs and the vendor Fresha
reaches it through:

| country | integration | integrator |
|---|---|---|
| `SA` (KSA) | `zatca` | `comarch` |
| `ES` | `verifactu`, `ticketbai` | `invopop` |
| `IT` | `smart_receipts` | `invopop` |

All three are one value or none — a tool that branches on whatever country the
document turns out to be leaves them out rather than naming one it does not mean.
`ops orion script list --country SA`, `--integration zatca`, `--integrator
invopop` and `--domain` filter on them, and typing any of them into
`ops interactive` narrows the screen the same way.

## Credentials

The scripts read their tokens from the environment and prompt when one is unset.
A script names the ones it reads in its frontmatter, and `ops run` asks for those
before the run, saves them to a git-ignored `.env` (mode 0600) and passes them in,
so the asking happens once:

```
$ ops run check_invopop_suppliers
ops ▸ check_invopop_suppliers needs INVOPOP_API_TOKEN
  saved to /…/ops/.env (0600, git-ignored) · Enter to skip and let the script ask
  INVOPOP_API_TOKEN:
ops ▸ run 43  check_invopop_suppliers  production · read-only · read-only — Read-only
```

ops never takes a secret from a script's own prompt — it hands the script your
terminal and never reads what you type into it. Values are never printed, never
put in a run record and never sent anywhere; a record keeps only the names.

A saved token that has gone stale would otherwise silence the script's own
prompt, so: a JWT is checked against its own `exp` and an expired one is asked
for again rather than passed; and when a run that was given a saved secret fails,
ops names it and offers to replace it. `ops secrets unset <NAME>` hands the
prompt back to the script at any time. What your shell exported always wins, so
`INVOPOP_API_TOKEN=other ops run …` is still a one-off. Full rules:
`ops help credentials`.

## Where things come from

| Shown by `ops` | Source of truth |
|---|---|
| summary, domain, country, integration, integrator, env, access, tier, status (incl. `retired`), examples, report globs, secrets | frontmatter at the top of the script's `AGENTS.md` |
| DESCRIPTION | the `What it does` / `Pipeline` / `Safety` / `Prereqs` / `Output` sections of that `AGENTS.md` |
| SCRIPT HELP (flags) | the script's own `--help`, run live for Node scripts |
| `orion/AGENTS.md` tables, `orion/.gitignore` report globs | generated between `ops:begin` / `ops:end` markers by `ops orion docs sync` |

## Layout

```
orion/                  the scripts: one <name>/ per script with an AGENTS.md each; .tool-versions
bin/ops                 entry: builds the commander program and maps errors to exit codes
lib/program.js          root program, gh-style help formatter, help topics, config / completion
lib/ui.js               colour (NO_COLOR), TTY vs TSV tables, JSON, wrap, pager, error classes
lib/screen.js           one frame of a raw-mode list: filter, headings, cursor, window, keymap
lib/config.js           ~/.config/ops/config.json
lib/secrets.js          the git-ignored .env: parse, save, expiry, the prompts before a run
lib/orion/index.js      registers `ops orion`
lib/orion/catalogue.js  frontmatter parser (strict YAML subset), dir walk, validation, name resolution
lib/orion/{list,view,run,pick,new,doctor,docs}.js
lib/orion/interactive.js the two-pane screen `ops interactive` loops over
lib/orion/task.js       the run lifecycle: run / ls / get / logs / rerun / cancel
lib/orion/runs.js       the run store under $OPS_STATE_DIR (record + log per run)
lib/orion/templates.js  scaffold strings for `script new`
docs/help-text-style.md the gh conventions every help page and summary follows
docs/adding-a-group.md  how to add `ops <group>`
```

Exit codes: 0 fine, 1 problems found (doctor, docs check), 2 the call was wrong.
`ops run` passes the script's exit code through verbatim.
