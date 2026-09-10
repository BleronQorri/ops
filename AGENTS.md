# ops — agent notes

A gh-style personal CLI. Node ≥ 20, CommonJS, one dependency (commander). Entry
`bin/ops`; code in `lib/`; one directory per command group under `lib/<group>/`.

## Rules

- **Never change what a script does.** `ops orion script run` spawns the entrypoint
  with `stdio: "inherit"`, the caller's cwd and untouched arguments. No added
  confirmations, no removed ones, no `--yes` injected, no chdir, no pty.
- **stdout is data, stderr is diagnostics.** Tables get headers and colour only on
  a TTY; piped output is TSV with no header. `--json` never changes field names
  based on the terminal. Colour is off under `NO_COLOR`.
- **Exit codes:** 0 fine · 1 problems found · 2 the call was wrong. Raise
  `ui.UsageError` (2) or `ui.ProblemsError` (1); `bin/ops` maps them. Commander's
  own usage errors are already exit 2.
- **Help pages follow gh.** Read `docs/help-text-style.md` before writing a
  `summary()`, `description()` or example. Attach USAGE / EXAMPLES / LEARN MORE
  through `gh(cmd, {...})` from `lib/program.js`, never with raw `addHelpText`.
- **Frontmatter is the source of truth** for the scripts catalogue; the root
  tables in the scripts repo are generated. If a field is added to the schema,
  update `KNOWN_KEYS` + `validateScript` in `lib/orion/catalogue.js`, the
  template in `lib/orion/templates.js`, the schema block in the scripts repo's
  root `AGENTS.md`, and the topic text in `lib/program.js` if user-visible.
- **No test suite.** Verify with the checklist below, by hand, against the real
  scripts repo (`OPS_ORION_SCRIPTS=<path>` points at a scratch copy when a
  change writes files).

## Adding a command group

See `docs/adding-a-group.md`. Short version: `lib/<group>/index.js` exporting
`register(program)`, required from `bin/ops`; `.helpGroup("GROUPS")` on the group
command; `.enablePositionalOptions()` on every ancestor of a command that uses
`.passThroughOptions()`.

## Verification checklist

```
ops · ops --help · ops orion · ops orion script run --help · ops help nope (exit 2)
ops orion script list · NO_COLOR=1 ops orion script list | cat -v · ops orion script list | cut -f1
ops orion script list --json | jq -r '.[].name' · ops orion script list -t bogus (exit 2)
ops orion script view retry_invoices · --raw · --path · | cat
ops orion script view process_missing_sales      (no live --help for Elixir, pointer shown)
ops orion script view fix_credit_note_references (status BLOCKED, blocked_on shown)
cd /tmp && ops orion script run retry_invoices --dry-run 1   (banner on stderr, report in /tmp, exit code == direct run)
ops orion script run ri --help  vs  ops orion script run --help
ops orion script run edit_document_payload (exit 2, points to view)
ops orion script run b2b_credit_notes/decode_payloads --help
ops orion doctor · --json · --fix on a scratch copy without .env
ops orion docs check · edit a summary → check fails → docs sync → git diff shows only marker regions
ops orion script new staging/write/zz_probe --lang js  (on a scratch copy) → docs check green → run zz_probe --help
ops alias set osr 'orion script run' && ops osr ri --help
ops completion zsh > /tmp/_ops && zsh -n /tmp/_ops
ops orion script pick (TTY) · ops orion script pick | cat (exit 2)
```
