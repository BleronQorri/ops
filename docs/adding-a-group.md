# Adding a command group

A group is `ops <group> …`: one directory under `lib/<group>/` with an `index.js`
that registers its commands on the root program.

```js
// lib/<group>/index.js
"use strict";
const { gh } = require("../program");

function register(program) {
  const grp = program
    .command("<group>")
    .summary("<one line, imperative, no period>")
    .description("<full sentences: what the group wraps and how it finds it>")
    .helpGroup("GROUPS")              // lists it under GROUPS in `ops --help`
    .enablePositionalOptions();       // required if any descendant uses passThroughOptions()

  gh(grp, { examples: [{ cmd: "ops <group> <command>" }] });

  grp.command("<command>")
    .summary("…")
    .description("…")
    .option("--json", "output JSON instead of a table")
    .action((opts) => { /* … */ });
}

module.exports = { register };
```

Then in `bin/ops`, after the orion line: `require("../lib/<group>").register(program);`.

## Conventions to keep

- Use `ui.table` / `ui.json` / `ui.pager` from `lib/ui.js`; never `console.log`
  colour escapes by hand.
- Throw `ui.UsageError(msg, hint)` for a bad call (exit 2) and
  `ui.ProblemsError(msg)` when the command ran but found problems (exit 1).
- Attach USAGE / EXAMPLES / LEARN MORE with `gh(cmd, {...})`; the formatter in
  `lib/program.js` renders them.
- Group-scoped configuration lives under `<group>.` in `~/.config/ops/config.json`
  (`config.get("<group>.something")`), with an environment override
  `OPS_<GROUP>_<KEY>` documented in the `environment` help topic.
- Sub-groups (`ops <group> <noun> <verb>`) follow `orion script`: the noun is a
  command with `.helpGroup("<NOUN> COMMANDS")` on the group page.
- Add the group's verification lines to `AGENTS.md`.
