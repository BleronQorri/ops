"use strict";

const fs = require("fs");
const path = require("path");
const ui = require("../ui");
const { c, UsageError } = ui;
const cat = require("./catalogue");
const T = require("./templates");

const NAME_RE = /^[a-z][a-z0-9_]*$/;

function register(script) {
  const { gh } = require("../program");
  const cmd = script
    .command("new")
    .summary("Scaffold <env>/<access>/<name>/ with AGENTS.md frontmatter and an entrypoint")
    .description("Create a new script directory that already follows the house conventions: an executable entrypoint with a shebang, `--help`, a single readline interface and a dry-run default, plus an AGENTS.md whose frontmatter passes `ops orion docs check`.\n\nAfter editing, run `ops orion docs sync` to add the script to the root catalogue.")
    .argument("<path>", "<env>/<access>/<name>, e.g. production/write/retry_things")
    .requiredOption("--lang <lang>", "js or exs")
    .option("--summary <text>", "one-line summary for the frontmatter", "TODO one-line summary")
    .option("--tier <tier>", `danger tier (default: read-only for read-only access, prod-write / sandbox otherwise)`)
    .action((rel, opts) => {
      const parts = rel.replace(/\/+$/, "").split("/");
      if (parts.length !== 3) throw new UsageError("path must be <env>/<access>/<name>");
      const [env, access, name] = parts;
      if (!cat.ENVS.includes(env)) throw new UsageError(`env must be one of ${cat.ENVS.join(", ")}`);
      if (!cat.ACCESSES.includes(access)) throw new UsageError(`access must be one of ${cat.ACCESSES.join(", ")}`);
      if (!NAME_RE.test(name)) throw new UsageError(`name must match ${NAME_RE} (snake_case)`);
      if (!cat.LANGS.includes(opts.lang)) throw new UsageError(`--lang must be one of ${cat.LANGS.join(", ")}`);
      const tier = opts.tier ?? (access === "read-only" ? "read-only" : env === "staging" ? "sandbox" : "prod-write");
      if (!cat.TIER_IDS.includes(tier)) throw new UsageError(`--tier must be one of ${cat.TIER_IDS.join(", ")}`);
      if (access === "read-only" && tier !== "read-only") throw new UsageError("read-only access requires tier read-only");

      const root = cat.scriptsRoot();
      const dir = path.join(root, env, access, name);
      if (fs.existsSync(dir)) throw new UsageError(`${path.relative(root, dir)} already exists`);
      const vars = { name, summary: opts.summary, env, access, tier, lang: opts.lang, defaultNamespace: env === "production" ? "production" : "eng-orion" };
      fs.mkdirSync(dir, { recursive: true });
      const entry = path.join(dir, `${name}.${opts.lang}`);
      fs.writeFileSync(path.join(dir, "AGENTS.md"), T.fill(T.AGENTS, vars));
      fs.writeFileSync(entry, T.fill(opts.lang === "js" ? T.JS : T.EXS, vars), { mode: 0o755 });
      process.stdout.write(`${c.ok("created")} ${path.relative(root, dir)}/\n  ${name}.${opts.lang}\n  AGENTS.md\n\nnext: edit both, then ${c.cmd("ops orion docs check")} and ${c.cmd("ops orion docs sync")}\n`);
    });
  gh(cmd, {
    usage: ["<env>/<access>/<name> --lang {js | exs} [flags]"],
    examples: [
      { cmd: "ops orion script new production/write/requeue_documents --lang js --summary 'Requeue rejected documents for resend'" },
      { cmd: "ops orion script new staging/write/seed_provider --lang exs --tier staging-destructive" },
    ],
  });
}

module.exports = { register };
