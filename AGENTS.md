# ops — agent notes

A gh-style personal CLI plus the operational scripts it runs. Node ≥ 20, CommonJS,
one dependency (commander). Entry `bin/ops`; code in `lib/`; one directory per
command group under `lib/<group>/`. The Orion scripts live in `orion/` (their own
`AGENTS.md` has the script conventions); the old `einvoicing-scripts` repo is
frozen — every update happens here.

## Rules

- **Never change what a script does.** `ops run` spawns the entrypoint
  with `stdio: "inherit"`, the caller's cwd and untouched arguments. No added
  confirmations, no removed ones, no `--yes` injected, no chdir. Output capture is
  the one thing allowed to bend: a pty via `script(1)` when stdin and stdout are
  both terminals, pipes when stdout is already piped, and nothing at all when the
  two disagree or no pty can be had — capture gives way, the run never does.
- **Production and staging are shown apart.** `ops orion script list` on a terminal
  prints a table per environment, read-only before write; a pipe still gets one flat
  TSV with the ENV column so nothing downstream breaks. The picker groups the same
  way, with headings the cursor skips.
- **Truncate with `ui.clip`, never `slice`.** A rendered line changes colour several
  times, and slicing the plain text throws every escape away. `ui.clip` walks the
  string, copies escapes and counts only visible columns.
- **Colour comes from one place.** `TIERS[tier].color` in `lib/orion/catalogue.js`
  names a palette key in `lib/ui.js`; render it with `cat.paintTier(text, tier,
  palette)`, passing `ui.c` for stdout or `ui.cerr` for stderr. Production writes are
  red and also say so in words. Never hard-code a tier's colour at a call site.
- **stdout is data, stderr is diagnostics.** Tables get headers and colour only on
  a TTY; piped output is TSV with no header. `--json` never changes field names
  based on the terminal. Colour is off under `NO_COLOR`.
- **Exit codes:** 0 fine · 1 problems found · 2 the call was wrong. Raise
  `ui.UsageError` (2) or `ui.ProblemsError` (1); `bin/ops` maps them. Commander's
  own usage errors are already exit 2.
- **Help pages follow gh.** Read `docs/help-text-style.md` before writing a
  `summary()`, `description()` or example. Attach USAGE / EXAMPLES / LEARN MORE
  through `gh(cmd, {...})` from `lib/program.js`, never with raw `addHelpText`.
- **Nothing has aliases.** Neither the scripts nor the commands, and there is no
  `ops alias` to make one. A name is typed in full, which is why it has to be a good
  one. Do not reintroduce a shortcut mechanism.
- **A script is named for what it does**: verb first, then the object, snake_case,
  and name the external system when more than one exists (Invopop, Comarch). Avoid
  `check`/`fix` where a specific verb exists (audit, patch, resend, wipe, backfill,
  match). The directory, the entrypoint and `name:` always agree. Renaming means
  `git mv` both, then a word-boundary rewrite of every mention — never inside a
  longer identifier, since `process_missing_sales_events` is a Houston task name.
- **Retiring a script is a frontmatter change, never a delete.** `status: retired`
  plus a one-line `retired_reason` (quote it if it cites a #ticket). It then leaves
  the catalogue and the generated tables, gains a row in the Retired table, and
  `ops run` refuses it; the file stays runnable on its own. Do not delete the
  directory — its AGENTS.md is the record of what was done.
- **Frontmatter is the source of truth** for the scripts catalogue; the root
  tables in the scripts repo are generated. If a field is added to the schema,
  update `KNOWN_KEYS` + `validateScript` in `lib/orion/catalogue.js`, the
  template in `lib/orion/templates.js`, the schema block in orion/'s
  root `AGENTS.md`, and the topic text in `lib/program.js` if user-visible.
- **No test suite.** Verify with the checklist below, by hand, against `orion/`
  (`OPS_ORION_SCRIPTS=<path>` points at a scratch copy when a change writes files).

## Adding a command group

See `docs/adding-a-group.md`. Short version: `lib/<group>/index.js` exporting
`register(program)`, required from `bin/ops`; `.helpGroup("GROUPS")` on the group
command; `.enablePositionalOptions()` on every ancestor of a command that uses
`.passThroughOptions()`.

## Verification checklist

```
ops · ops --help · ops orion · ops run --help · ops help nope (exit 2)
ops orion script list (two sections on a tty) · --flat · NO_COLOR=1 … | cat -v · … | cut -f1 (flat, ENV kept)
ops orion script list --json | jq -r '.[].name'  ·  --status retired  ·  --include-retired · ops orion script list -t bogus (exit 2)
ops orion script view resend_stuck_invoices · --raw · --path · | cat  (md tables render as box tables, blockquotes as a bar)
ops orion script view backfill_missing_documents      (no live --help for Elixir, pointer shown)
ops orion script view fix_credit_note_references (status BLOCKED, blocked_on shown)
cd /tmp && ops task run resend_stuck_invoices --dry-run 1   (banner + trailer on stderr, report in /tmp, exit code == direct run)
ops task run ri --help  vs  ops task run --help
ops task run edit_document_payload (exit 2, points to view)
ops task run match_credit_notes_to_invoices/decode_payloads --help
ops task run -p K=V <script>  (env var reaches the script; -p AFTER the name goes to the script + prints a note)
ops task ls · --script · --status · --param K=V · --param K~V · --since 7d · -L · --json
ops task get <id> [--json] · task logs <id> [--raw] · task rerun <id> · task cancel <id> (on a running one, and on a finished one -> exit 1)
ops run <name>  (still works: same recorded path as task run)
ops orion doctor · --json
ops orion docs check · edit a summary → check fails → docs sync → git diff shows only marker regions
ops orion script new zz_probe --lang js --env staging --access write  (on a scratch copy) → docs check green → run zz_probe --help
ops completion zsh > /tmp/_ops && zsh -n /tmp/_ops
ops orion script pick (TTY) · ops orion script pick | cat (exit 2)
```
