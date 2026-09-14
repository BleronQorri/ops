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
    .summary("Scaffold orion/<name>/ with AGENTS.md frontmatter and an entrypoint")
    .description("Create orion/<name>/ following the house conventions: an executable entrypoint with a shebang, `--help`, a single readline interface and a dry-run default, plus an AGENTS.md whose frontmatter passes `ops orion docs check`.\n\nAfter editing, run `ops orion docs sync` to add the script to the root catalogue.")
    .argument("<name>", "snake_case directory and entrypoint name, e.g. retry_things")
    .requiredOption("--lang <lang>", "js or exs")
    .requiredOption("--domain <domain>", "what it is about: e-invoicing or accounting-documents")
    .option("--country <code>", "ISO 3166-1 alpha-2 the script is for, when it is for one (ES, IT, SA)")
    .option("--integration <name>", "the country's scheme (verifactu, zatca, smart_receipts)")
    .option("--integrator <name>", "who Fresha reaches it through (invopop, comarch)")
    .requiredOption("--env <env>", "production or staging")
    .requiredOption("--access <access>", "read-only or write")
    .option("--summary <text>", "one-line summary for the frontmatter", "TODO one-line summary")
    .option("--tier <tier>", `danger tier (default: read-only for read-only access, staging or prod-write otherwise)`)
    .action((name, opts) => {
      const { env, access } = opts;
      if (!cat.ENVS.includes(env)) throw new UsageError(`env must be one of ${cat.ENVS.join(", ")}`);
      if (!cat.ACCESSES.includes(access)) throw new UsageError(`access must be one of ${cat.ACCESSES.join(", ")}`);
      if (!NAME_RE.test(name)) throw new UsageError(`name must match ${NAME_RE} (snake_case)`);
      if (!cat.LANGS.includes(opts.lang)) throw new UsageError(`--lang must be one of ${cat.LANGS.join(", ")}`);
      if (!cat.DOMAIN_IDS.includes(opts.domain)) throw new UsageError(`--domain must be one of ${cat.DOMAIN_IDS.join(", ")}`);
      if (opts.country !== undefined && !cat.COUNTRY_RE.test(opts.country)) throw new UsageError("--country must be an ISO 3166-1 alpha-2 code, e.g. ES");
      for (const key of ["integration", "integrator"]) {
        if (opts[key] !== undefined && !cat.SLUG_RE.test(opts[key])) throw new UsageError(`--${key} must be lower_snake_case, e.g. smart_receipts`);
      }
      if (opts.domain !== "e-invoicing" && (opts.country || opts.integration || opts.integrator)) {
        throw new UsageError("--country, --integration and --integrator belong to --domain e-invoicing");
      }
      const tier = opts.tier ?? (access === "read-only" ? "read-only" : env === "staging" ? "staging" : "prod-write");
      if (!cat.TIER_IDS.includes(tier)) throw new UsageError(`--tier must be one of ${cat.TIER_IDS.join(", ")}`);
      if (access === "read-only" && tier !== "read-only") throw new UsageError("read-only access requires tier read-only");

      const root = cat.scriptsRoot();
      const dir = path.join(root, name);
      if (fs.existsSync(dir)) throw new UsageError(`${path.relative(root, dir)} already exists`);
      const classification = [["domain", opts.domain], ["country", opts.country], ["integration", opts.integration], ["integrator", opts.integrator]]
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}: ${v}\n`)
        .join("");
      const vars = { name, summary: opts.summary, classification, env, access, tier, lang: opts.lang, defaultNamespace: env === "production" ? "production" : "eng-orion" };
      fs.mkdirSync(dir, { recursive: true });
      const entry = path.join(dir, `${name}.${opts.lang}`);
      fs.writeFileSync(path.join(dir, "AGENTS.md"), T.fill(T.AGENTS, vars));
      fs.writeFileSync(entry, T.fill(opts.lang === "js" ? T.JS : T.EXS, vars), { mode: 0o755 });
      process.stdout.write(`${c.ok("created")} ${path.relative(root, dir)}/\n  ${name}.${opts.lang}\n  AGENTS.md\n\nnext: edit both, then ${c.cmd("ops orion docs check")} and ${c.cmd("ops orion docs sync")}\n`);
    });
  gh(cmd, {
    usage: ["<name> --lang {js | exs} --domain {e-invoicing | accounting-documents} --env {production | staging} --access {read-only | write} [flags]"],
    examples: [
      { cmd: "ops orion script new requeue_documents --lang js --domain e-invoicing --country SA --integration zatca --integrator comarch --env production --access write" },
      { cmd: "ops orion script new seed_provider --lang exs --env staging --access write" },
    ],
  });
}

module.exports = { register };
