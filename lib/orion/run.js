"use strict";

// `ops orion script run` is the older spelling of `ops orion task run`. Both go
// through the same recorded path in ./task.js, so there is one implementation.

const task = require("./task");


function register(script, { reserved }) {
  const { gh } = require("../program");
  const cmd = script
    .command("run")
    .summary("Run a script (alias of `ops orion task run`)")
    .description("Run a script by name or alias, recording the run. This is the same command as `ops orion task run` — see there for the full description, and `ops orion task ls` for what was recorded.")
    .argument("<script>", "script name, alias, or <name>/<file> for a secondary entrypoint")
    .argument("[args...]", "arguments for the script")
    .passThroughOptions()
    .allowUnknownOption()
    .allowExcessArguments()
    .option("-p, --param <KEY=VALUE>", "parameter passed to the script as an environment variable; repeatable. Must precede <script>", (v, acc = []) => (acc.push(v), acc))
    .option("--no-log", "do not capture the output")
    .action(async (token, args, opts) => {
      process.exitCode = await task.doRun({ token, args, params: task.parseParams(opts.param || []), log: opts.log !== false, reserved });
    });
  gh(cmd, {
    usage: ["[flags] <script> [<script-args>...]"],
    examples: [
      { cmd: "ops orion script run retry_invoices --dry-run 123,456" },
      { cmd: "ops orion task run retry_invoices --dry-run 123,456", note: "the same thing, in the task lifecycle spelling" },
    ],
    learnMore: ["Recorded runs: `ops orion task ls`, `ops orion task get <id>`, `ops orion task logs <id>`."],
  });
}

module.exports = { register };
