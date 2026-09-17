"use strict";

const ui = require("../ui");
const { UsageError } = ui;
const cat = require("./catalogue");

const FIELDS = ["name", "domain", "country", "integration", "integrator", "env", "access", "tier", "status", "lang", "summary", "entrypoint", "dir", "also", "secrets", "reports", "related", "blocked_on", "retired_reason", "retired_on"];
const DEFAULT_FIELDS = ["name", "domain", "env", "access", "country", "integration", "tier", "status", "summary"];
// The two the sections are made of: headings on a terminal, columns in a pipe.
const GROUPING_FIELDS = ["domain", "integration"];
// Columns that only some domains have anything to say in. A section where every
// one of them is empty drops them rather than printing a column of dashes — and
// so does one where every heading has already given the answer.
const OPTIONAL_FIELDS = ["country", "integration", "integrator"];

function checkValues(flag, values, allowed) {
  for (const v of values) if (!allowed.includes(v)) throw new UsageError(`invalid --${flag} value: ${v}`, `allowed: ${allowed.join(", ")}`);
}

function toRecord(s) {
  return {
    name: s.name,
    domain: s.domain ?? null,
    country: s.country ?? null,
    integration: s.integration ?? null,
    integrator: s.integrator ?? null,
    env: s.env,
    access: s.access,
    tier: s.tier ?? null,
    status: s.legacy ? "unannotated" : s.status,
    lang: s.lang ?? null,
    summary: s.summary,
    entrypoint: s.entrypoint ?? null,
    also: s.also,
    secrets: s.secrets,
    dir: s.dir,
    reports: s.reports,
    related: s.related,
    blocked_on: s.blocked_on ?? null,
    retired_reason: s.retired_reason ?? null,
    retired_on: s.retired_on ?? null,
  };
}

function register(script) {
  const { gh } = require("../program");
  const cmd = script
    .command("list")
    .summary("List scripts in the catalogue")
    .description("List the live scripts in orion/ with their environment, access, danger tier, status and one-line summary.\n\nOn a terminal the output is a table with a header. When piped it is tab-separated with no header and no colour, so `cut -f1` gives bare names. On a terminal each domain is a section and each integration a table inside it, so everything pointed at one scheme sits together; `--flat` puts them all back in one table.\n\n`--json` emits every frontmatter field.\n\nRetired scripts are left out unless you ask for them with `--include-retired` or `--status retired`.")
    .option("-d, --domain <domain>", `filter by domain (${cat.DOMAIN_IDS.join(", ")}); repeatable`, collect, [])
    .option("-c, --country <code>", "filter by country, ISO 3166-1 alpha-2 (ES, IT, SA); repeatable", collect, [])
    .option("-i, --integration <name>", `filter by integration (e.g. ${cat.INTEGRATION_IDS.join(", ")}); repeatable`, collect, [])
    .option("--integrator <name>", "filter by integrator (invopop, comarch); repeatable", collect, [])
    .option("-e, --env <env>", "filter by environment (production, staging); repeatable", collect, [])
    .option("-a, --access <access>", "filter by access (read-only, write); repeatable", collect, [])
    .option("-t, --tier <tier>", "filter by danger tier; repeatable (see `ops help tiers`)", collect, [])
    .option("-s, --status <status>", `filter by status (${cat.STATUSES.join(", ")}); repeatable`, collect, [])
    .option("--include-retired", "also list retired scripts, which are hidden by default")
    .option("--json", "output JSON instead of a table")
    .option("--flat", "one table for everything instead of a section per domain and integration")
    .option("--fields <list>", `comma-separated columns for the table (default: ${DEFAULT_FIELDS.join(",")})`)
    .action((opts) => {
      checkValues("domain", opts.domain, cat.DOMAIN_IDS);
      checkValues("env", opts.env, cat.ENVS);
      checkValues("access", opts.access, cat.ACCESSES);
      checkValues("tier", opts.tier, cat.TIER_IDS);
      checkValues("status", opts.status, cat.STATUSES);
      const fields = opts.fields ? opts.fields.split(",").map((f) => f.trim()) : DEFAULT_FIELDS;
      checkValues("fields", fields, FIELDS);

      const c = cat.loadCatalogue();
      let rows = c.scripts.map(toRecord);
      // Written as they are in the frontmatter, matched however you type them.
      const country = opts.country.map((v) => v.toUpperCase());
      const integration = opts.integration.map((v) => v.toLowerCase());
      const integrator = opts.integrator.map((v) => v.toLowerCase());
      if (opts.domain.length) rows = rows.filter((r) => opts.domain.includes(r.domain));
      if (country.length) rows = rows.filter((r) => country.includes(r.country));
      if (integration.length) rows = rows.filter((r) => integration.includes(r.integration));
      if (integrator.length) rows = rows.filter((r) => integrator.includes(r.integrator));
      if (opts.env.length) rows = rows.filter((r) => opts.env.includes(r.env));
      if (opts.access.length) rows = rows.filter((r) => opts.access.includes(r.access));
      if (opts.tier.length) rows = rows.filter((r) => opts.tier.includes(r.tier));
      if (opts.status.length) rows = rows.filter((r) => opts.status.includes(r.status));
      // Retired scripts are decommissioned: out of the way unless asked for.
      else if (!opts.includeRetired) rows = rows.filter((r) => !cat.HIDDEN_STATUSES.has(r.status));

      if (opts.json) return process.stdout.write(ui.json(rows));
      const cell = (r, f) => {
        const v = r[f];
        if (Array.isArray(v)) return v.join(",");
        if (v === null || v === undefined) return process.stdout.isTTY ? ui.c.faint("-") : "";
        if (f === "status" && process.stdout.isTTY) return v === "active" ? ui.c.ok(v) : ui.c.warn(v);
        // The tier is the one thing worth spotting from across the room.
        if (f === "tier" && process.stdout.isTTY) return cat.paintTier(v, v, ui.c);
        return String(v);
      };

      // Piped: one flat table, every field, no headings — the DOMAIN and INTEGRATION
      // columns carry the headings, so nothing is lost to a script.
      if (!process.stdout.isTTY || opts.flat) {
        process.stdout.write(ui.table(rows.map((r) => fields.map((f) => cell(r, f))), fields.map((f) => f.toUpperCase())));
        return;
      }

      // On a terminal the two grouping fields become headings and leave the
      // columns: what a script is about first, then which scheme it talks to,
      // which is what sends anyone to this list in the first place. The
      // environment stays a column, sorted so production and staging still sit in
      // blocks inside a table.
      const grouped = fields.filter((f) => !GROUPING_FIELDS.includes(f));
      const count = (n) => ui.c.faint(`${n} script${n === 1 ? "" : "s"}`);
      const sections = [];
      for (const domain of cat.domainOrder(rows)) {
        const inDomain = rows.filter((r) => cat.domainOf(r) === domain);
        if (!inDomain.length) continue;
        const groups = cat
          .integrationOrder(inDomain)
          .map((id) => {
            const items = inDomain.filter((r) => cat.integrationOf(r) === id).sort(cat.byEnvAccessName);
            return { group: cat.integrationGroup(id, items), items };
          })
          .filter((g) => g.items.length);
        // Decided once per domain, so the tables inside it still line up with each
        // other. An optional column survives only where a row whose own heading has
        // not already given the answer still has something to say in it.
        const cols = grouped.filter(
          (f) =>
            !OPTIONAL_FIELDS.includes(f) ||
            groups.some((g) => !g.group.covers.includes(f) && g.items.some((r) => r[f] !== null && r[f] !== undefined)),
        );
        const blocks = [`${ui.c.header(cat.domainLabel(domain).toUpperCase())}  ${count(inDomain.length)}`];
        for (const { group, items } of groups) {
          blocks.push(`  ${ui.c.header(group.label.toUpperCase())}  ${count(items.length)}`);
          const body = ui.table(items.map((r) => cols.map((f) => cell(r, f))), cols.map((f) => f.toUpperCase()), { maxWidth: ui.width() - 2 }).replace(/\n$/, "");
          blocks.push(body.replace(/^/gm, "  "));
        }
        sections.push(blocks.join("\n"));
      }
      process.stdout.write(sections.join("\n\n") + "\n");
      const errors = c.problems.filter((p) => p.level === "error").length;
      if (errors && process.stdout.isTTY) ui.eprint(ui.cerr.faint(`${errors} catalogue problem(s) — run \`ops orion docs check\``));
    });
  gh(cmd, {
    usage: ["[flags]"],
    examples: [
      { cmd: "ops orion script list" },
      { cmd: "ops orion script list --env production --access write" },
      { cmd: "ops orion script list --country SA", note: "everything pointed at one tax authority" },
      { cmd: "ops orion script list --integration verifactu --integration zatca", note: "two schemes, a table each" },
      { cmd: "ops orion script list --domain accounting-documents" },
      { cmd: "ops orion script list --tier read-only --tier staging", note: "filters of the same flag OR together, different flags AND" },
      { cmd: "ops orion script list | cut -f1", note: "bare names when piped" },
      { cmd: "ops orion script list --status retired", note: "what has been decommissioned, and why" },
      { cmd: "ops orion script list --json | jq -r '.[] | select(.status == \"blocked\") | .name'" },
    ],
  });
}

function collect(v, acc) {
  acc.push(v);
  return acc;
}

module.exports = { register, toRecord, FIELDS };
