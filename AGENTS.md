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
- **The interactive screen is a loop of frames.** `lib/screen.js` draws one
  frame, resolves on the key that means something and erases itself; the loop in
  `lib/orion/interactive.js` acts on that and draws the next one. Anything that
  takes over the terminal — a pager, a script's own prompts and output — happens
  between frames, never underneath one, and every key calls the same function
  the command of that name calls (`task.doRun`, `task.doCancel`, `renderView`).
  A screen never runs, cancels or renders anything its own way. Esc is read from
  the raw stream, not from readline, which never reports a lone one.
- **A secret is asked for, never captured, and never written down.** ops does not
  read a script's own prompt: `ops run` gives the script the terminal and never
  touches its stdin, and a captured log would hold whatever the script echoed. So
  a script declares what it reads (`secrets:` in its frontmatter), ops asks before
  the run with the echo off, saves to the git-ignored `.env` (mode 0600, written
  through `lib/secrets.js`) and passes it in. Values never reach a run record, a
  table, `--json` or a log — a record keeps names only. Precedence is .env, then
  the shell, then `-p`. Skipping a prompt is always allowed and the run goes ahead.
- **A saved credential is assumed stale until it proves otherwise.** A set
  variable silences the script's own prompt, so ops checks a JWT against its
  `exp` and withholds an expired one, and offers a replacement after a run that
  had one and failed. It never decides on its own that a token is bad: only the
  script knows why it failed, so ops asks.
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
ops secrets set X (prompts, echo off) · set X value · list (names only, TSV when piped) · unset · path · list --json
ops run <script with secrets:> (asks once, saves, injects) · again (no prompt) · --no-secrets (no prompt, nothing passed)
ops run <it> </dev/null (no prompt, no hang) · a saved JWT past its exp (withheld, asked again)
a failing run that was given one (offered, n changes nothing, y replaces) · grep the run store for the value (absent)
ops orion script view check_invopop_suppliers (Secrets row) · ops help credentials · git check-ignore .env
ops orion script pick (TTY) · ops orion script pick | cat (exit 2)
ops interactive (TTY): ↑↓ jk pgup pgdn home end · / filter · esc clears it · tab both ways · ? · t · q
ops interactive: enter on a script (pager) · d · r (banner, output, ↵ back, the run in the runs pane)
ops interactive: enter on a run · l (and on one with captured: none) · r · x (on a finished one)
ops interactive | cat (exit 2) · ops config set interactive.bare true → bare `ops` opens it, `ops | cat` still prints the short help
```
