"use strict";

const ui = require("../ui");
const { UsageError } = ui;
const cat = require("./catalogue");

const FIELDS = ["name", "env", "access", "tier", "status", "lang", "summary", "aliases", "entrypoint", "dir", "also", "reports", "related", "blocked_on"];
const DEFAULT_FIELDS = ["name", "env", "access", "tier", "status", "summary"];

function checkValues(flag, values, allowed) {
  for (const v of values) if (!allowed.includes(v)) throw new UsageError(`invalid --${flag} value: ${v}`, `allowed: ${allowed.join(", ")}`);
}

function toRecord(s) {
  return {
    name: s.name,
    env: s.env,
    access: s.access,
    tier: s.tier ?? null,
    status: s.legacy ? "unannotated" : s.status,
    lang: s.lang ?? null,
    summary: s.summary,
    aliases: s.aliases,
    entrypoint: s.entrypoint ?? null,
    also: s.also,
    dir: s.dir,
    reports: s.reports,
    related: s.related,
    blocked_on: s.blocked_on ?? null,
  };
}

function register(script, { reserved }) {
  const { gh } = require("../program");
  const cmd = script
    .command("list")
    .alias("ls")
    .summary("List scripts in the catalogue")
    .description("List every script in orion/ with its environment, access, danger tier, status and one-line summary.\n\nOn a terminal the output is a table with a header. When piped it is tab-separated with no header and no colour, so `cut -f1` gives bare names. `--json` emits every frontmatter field.")
    .option("-e, --env <env>", "filter by environment (production, staging); repeatable", collect, [])
    .option("-a, --access <access>", "filter by access (read-only, write); repeatable", collect, [])
    .option("-t, --tier <tier>", "filter by danger tier; repeatable (see `ops help tiers`)", collect, [])
    .option("-s, --status <status>", "filter by status (active, deprecated, runbook, blocked); repeatable", collect, [])
    .option("--json", "output JSON instead of a table")
    .option("--fields <list>", `comma-separated columns for the table (default: ${DEFAULT_FIELDS.join(",")})`)
    .action((opts) => {
      checkValues("env", opts.env, cat.ENVS);
      checkValues("access", opts.access, cat.ACCESSES);
      checkValues("tier", opts.tier, cat.TIER_IDS);
      checkValues("status", opts.status, cat.STATUSES);
      const fields = opts.fields ? opts.fields.split(",").map((f) => f.trim()) : DEFAULT_FIELDS;
      checkValues("fields", fields, FIELDS);

      const c = cat.loadCatalogue({ reserved });
      let rows = c.scripts.map(toRecord);
      if (opts.env.length) rows = rows.filter((r) => opts.env.includes(r.env));
      if (opts.access.length) rows = rows.filter((r) => opts.access.includes(r.access));
      if (opts.tier.length) rows = rows.filter((r) => opts.tier.includes(r.tier));
      if (opts.status.length) rows = rows.filter((r) => opts.status.includes(r.status));

      if (opts.json) return process.stdout.write(ui.json(rows));
      const cell = (r, f) => {
        const v = r[f];
        if (Array.isArray(v)) return v.join(",");
        if (v === null || v === undefined) return process.stdout.isTTY ? ui.c.faint("-") : "";
        if (f === "status" && process.stdout.isTTY) return v === "active" ? v : ui.c.warn(v);
        return String(v);
      };
      process.stdout.write(ui.table(rows.map((r) => fields.map((f) => cell(r, f))), fields.map((f) => f.toUpperCase())));
      const errors = c.problems.filter((p) => p.level === "error").length;
      if (errors && process.stdout.isTTY) ui.eprint(ui.cerr.faint(`${errors} catalogue problem(s) — run \`ops orion docs check\``));
    });
  gh(cmd, {
    usage: ["[flags]"],
    examples: [
      { cmd: "ops orion script list" },
      { cmd: "ops orion script list --env production --access write" },
      { cmd: "ops orion script list --tier read-only --tier sandbox", note: "filters of the same flag OR together, different flags AND" },
      { cmd: "ops orion script list | cut -f1", note: "bare names when piped" },
      { cmd: "ops orion script list --json | jq -r '.[] | select(.status == \"blocked\") | .name'" },
    ],
  });
}

function collect(v, acc) {
  acc.push(v);
  return acc;
}

module.exports = { register, toRecord, FIELDS };
