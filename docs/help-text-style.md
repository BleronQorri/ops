# Help-text style

Adopted from the GitHub CLI's `docs/command-line-syntax.md` and
`docs/command-development.md`. Every command page in `ops`, and every script
`summary:` in the Orion scripts repo, follows these rules.

## Syntax in USAGE lines

| Form | Meaning | Example |
|---|---|---|
| plain text | literal, required | `ops orion script run` |
| `<dash-case>` | a value the user supplies | `<script>`, `<provider-id>` |
| `[...]` | optional | `[flags]`, `[<script-args>...]` |
| `{a \| b}` | required, pick one | `--lang {js \| exs}` |
| `...` | repeatable | `<tracker-id>...` |

Multi-word placeholders are dash-case: `<issue-number>`, never `<issueNumber>`
or `<ISSUE_NUMBER>`.

## The page

```
<long description: full sentences, why before how>

USAGE
  ops orion script run <script> [<script-args>...]

FLAGS
  -e, --env <env>   filter by environment; repeatable

INHERITED FLAGS
  --help            Show help for command

EXAMPLES
  # one comment line when the intent is not obvious
  $ ops orion script run ri --dry-run 123,456

LEARN MORE
  Use `ops orion script <command> --help` for more information about a command.
```

Sections appear in that order and only when non-empty. Headers are uppercase,
two-space indented bodies.

## Words

- **Summary** (gh "Short", the `summary()` of a command and the `summary:` of a
  script): one line, sentence case, starts with an imperative verb, no trailing
  period, ≤ 110 characters. `List scripts in the catalogue`, not `Lists the
  scripts.` or `This command lists…`.
- **Description** (gh "Long"): complete sentences. Say what it does, then what
  it does not do, then the non-obvious behaviour (TTY handling, defaults, exit
  codes). Backticks for every flag, command, file and value.
- **Flag descriptions**: lowercase fragment, no period; name the default in
  parentheses when there is one; say `repeatable` when the flag collects.
- **Examples**: real values, `$ ` prefix, a `# comment` line above only when the
  command alone does not explain itself. Three to five per page.
- Never invent a term. Reuse the words the scripts and their AGENTS.md use.

## Output contract

- stdout carries data, stderr carries diagnostics and banners.
- On a TTY: tables have a header row and colour. Piped: TSV, no header, no
  colour. `NO_COLOR` disables colour everywhere.
- `--json` field names and types never depend on the terminal.
- Every prompt has a non-interactive path (a flag). `ops` itself only prompts in
  `pick` and `interactive`, both of which refuse to start without a terminal and
  have a flag-driven equivalent (`script list`, `task ls`); the scripts keep
  their own rules.
- Errors are one line on stderr: `error: <what>` then an optional hint line
  naming the command that fixes it.
- Exit codes: 0 fine · 1 problems found · 2 the call was wrong.
