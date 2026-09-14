"use strict";

// The Orion scripts catalogue: finds the scripts directory (orion/), walks its
// one-directory-per-script children, parses each AGENTS.md frontmatter, validates
// it and resolves a name or a secondary entrypoint to something runnable.

const fs = require("fs");
const path = require("path");
const config = require("../config");
const { UsageError } = require("../ui");

const ENVS = ["production", "staging"];
const ACCESSES = ["read-only", "write"];
const STATUSES = ["active", "deprecated", "retired", "runbook", "blocked"];

// A retired script is decommissioned: the work it existed for is finished. It stays
// on disk because its document is the record of what was done, but it is kept out
// of the way — absent from the catalogue unless asked for by name or status, and
// refused by `ops run`. Running the file directly still works; that is the house
// rule and no wrapper gets to break it.
const LANGS = ["js", "exs"];
const SHEBANG = { js: "#!/usr/bin/env node", exs: "#!/usr/bin/env elixir" };
// `color` names a key of the palette in ../ui.js. Anything that writes production
// is red, wherever it is shown — the list, a script's page, a run's banner and the
// run history all read from here, so there is one place that decides.
const TIERS = {
  "read-only": { label: "Read-only", blurb: "SELECTs and external GETs only; cannot write anywhere", color: "ok" },
  "prod-write": { label: "Prod writes (gated, reversible-ish)", blurb: "gated Houston tasks; dry run by default; requires a terminal", color: "bad" },
  "prod-write-irreversible": { label: "Prod writes, partner-visible, one step irreversible", blurb: "at least one step cannot be undone", color: "bad" },
  "prod-write-no-dry-run": { label: "Prod writes with NO dry run", blurb: "the underlying task writes on the first call", color: "bad" },
  staging: { label: "Staging / sandbox", blurb: "non-production only — the staging databases, the Invopop sandbox, Comarch UAT; refuses production, and some of it deletes rows", color: "warn" },
};

// The tiers that write real production data.
const PROD_WRITE_TIERS = new Set(["prod-write", "prod-write-irreversible", "prod-write-no-dry-run"]);

function isProdWrite(tier) {
  return PROD_WRITE_TIERS.has(tier);
}

// Paint text in a tier's colour, using the caller's palette (stdout's or stderr's).
function paintTier(text, tier, palette) {
  const key = TIERS[tier]?.color;
  const paint = key && palette ? palette[key] : null;
  return paint ? paint(text) : String(text);
}
const TIER_IDS = Object.keys(TIERS);
const SUMMARY_MAX = 110;
const DOC_ONLY = new Set(["runbook", "blocked"]);

// Statuses hidden from listings by default.
const HIDDEN_STATUSES = new Set(["retired"]);

// A frontmatter `secrets:` entry names an environment variable, so it is spelt
// like one. ops prompts for these and injects them; see lib/secrets.js.
const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

// What a script is about, and the order the sections appear in. Every script
// declares one: it is the first thing the catalogue groups by, above the
// environment, because which country's tax authority a tool talks to matters more
// than which database it points at.
const DOMAINS = {
  "e-invoicing": { label: "E-invoicing", blurb: "talks to a tax authority, or to the documents on their way to one" },
  "accounting-documents": { label: "Accounting documents", blurb: "the documents themselves: generating, backfilling, onboarding" },
};
const DOMAIN_IDS = Object.keys(DOMAINS);

// Where a script goes when its domain is missing or not one we know. A grouped
// view must never drop a row for want of a heading to put it under: an
// unclassified script is a catalogue problem to fix, and hiding it from the one
// view most people use is how it stays unfixed.
const UNCLASSIFIED = "unclassified";

function domainOf(s) {
  return DOMAIN_IDS.includes(s.domain) ? s.domain : UNCLASSIFIED;
}

function domainLabel(id) {
  return DOMAINS[id]?.label ?? "Unclassified";
}

// The domains these scripts actually use, in display order, unclassified last.
function domainOrder(scripts) {
  const present = new Set(scripts.map(domainOf));
  return [...DOMAIN_IDS.filter((d) => present.has(d)), ...(present.has(UNCLASSIFIED) ? [UNCLASSIFIED] : [])];
}

// A country is ISO 3166-1 alpha-2 (ES, IT, SA). An integration is the scheme the
// country runs (verifactu, zatca, smart_receipts) and an integrator is whoever
// Fresha reaches it through (invopop, comarch). All three are one value or none:
// a tool that serves every country leaves them out rather than guessing.
const COUNTRY_RE = /^[A-Z]{2}$/;
const SLUG_RE = /^[a-z][a-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Locating the repo
// ---------------------------------------------------------------------------

function scriptsRoot() {
  const candidates = [
    ["OPS_ORION_SCRIPTS", process.env.OPS_ORION_SCRIPTS],
    ["ops config orion.scripts", config.get("orion.scripts")],
    ["ops repo orion/", path.resolve(__dirname, "..", "..", "orion")],
  ];
  for (const [, p] of candidates) {
    if (p && fs.existsSync(path.join(p, "AGENTS.md"))) return path.resolve(p);
  }
  throw new UsageError(
    "cannot find the Orion scripts directory",
    "set it with `ops config set orion.scripts <path>` or export OPS_ORION_SCRIPTS (tried: " + candidates.map(([k, v]) => `${k}=${v ?? "unset"}`).join(", ") + ")",
  );
}

// ---------------------------------------------------------------------------
// Frontmatter: a strict YAML subset
//   key: scalar        (bare, "quoted", 'quoted'; true/false -> boolean)
//   key: [a, b]        inline list of scalars
//   key:               block list of scalars or of maps
//     - a
//     - k: v
//       k2: v2
//   # comments
// ---------------------------------------------------------------------------

function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return { present: false, data: null, body: text, errors: [] };
  const end = lines.indexOf("---", 1);
  if (end === -1) return { present: true, data: null, body: text, errors: ["frontmatter opened on line 1 but never closed with `---`"] };
  const { data, errors } = parseYamlSubset(lines.slice(1, end), 2);
  return { present: true, data, body: lines.slice(end + 1).join("\n"), errors };
}

// Index of the quote that closes the one this value opens with, respecting \" in a
// double-quoted scalar. -1 when there is none.
function closingQuote(s) {
  const q = s[0];
  for (let i = 1; i < s.length; i++) {
    if (q === '"' && s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === q) return i;
  }
  return -1;
}

function unquote(raw) {
  const s = raw.trim();
  if (s === "true") return true;
  if (s === "false") return false;
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s); // handles \" and \\ escapes
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return s;
}

function parseInlineList(s, errors, ln) {
  const inner = s.trim().slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((x) => {
    const v = unquote(x);
    if (typeof v !== "string" || v === "") errors.push(`line ${ln}: inline list items must be non-empty scalars`);
    return v;
  });
}

function parseYamlSubset(lines, firstLineNo) {
  const data = {};
  const errors = [];
  let i = 0;
  const ln = () => firstLineNo + i;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (!m) {
      errors.push(`line ${ln()}: expected \`key: value\`, got ${JSON.stringify(line)}`);
      i++;
      continue;
    }
    const key = m[1];
    const rest = m[2].trim();
    if (key in data) errors.push(`line ${ln()}: duplicate key ${key}`);
    if (rest === "") {
      // block list follows
      const items = [];
      i++;
      while (i < lines.length && (/^\s*-\s/.test(lines[i]) || /^\s+\S/.test(lines[i]) || lines[i].trim() === "")) {
        const l = lines[i];
        if (l.trim() === "") {
          i++;
          continue;
        }
        const dm = /^(\s*)-\s+(.*)$/.exec(l);
        if (!dm) {
          errors.push(`line ${ln()}: expected a \`- item\` under ${key}`);
          i++;
          continue;
        }
        const indent = dm[1].length;
        const first = dm[2];
        const km = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(first);
        if (km) {
          // list of maps
          const obj = { [km[1]]: unquote(km[2]) };
          i++;
          while (i < lines.length && /^\s+\S/.test(lines[i]) && !/^\s*-\s/.test(lines[i])) {
            const cm = /^(\s+)([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(lines[i]);
            if (!cm || cm[1].length <= indent) {
              errors.push(`line ${ln()}: expected an indented \`key: value\` continuing the ${key} item`);
              i++;
              continue;
            }
            obj[cm[2]] = unquote(cm[3]);
            i++;
          }
          items.push(obj);
        } else {
          items.push(unquote(first));
          i++;
        }
      }
      data[key] = items;
      continue;
    }
    if (rest.startsWith("[")) {
      if (!rest.endsWith("]")) errors.push(`line ${ln()}: inline list for ${key} must close with ]`);
      data[key] = parseInlineList(rest, errors, ln());
    } else if (/^[|>]/.test(rest) || rest.startsWith("&") || rest.startsWith("*") || rest.startsWith("{")) {
      errors.push(`line ${ln()}: block scalars, anchors and maps are not supported (${key})`);
    } else if (/^["']/.test(rest)) {
      // Quoted: the value ends at its closing quote, and a # inside it is text, not a
      // comment. Only what follows the quote can be one.
      const end = closingQuote(rest);
      if (end === -1) {
        errors.push(`line ${ln()}: ${key} opens a quote it never closes`);
        data[key] = unquote(rest);
      } else {
        data[key] = unquote(rest.slice(0, end + 1));
        const tail = rest.slice(end + 1).trim();
        if (tail && !tail.startsWith("#")) {
          errors.push(`line ${ln()}: ${key} has unexpected text after the closing quote: ${JSON.stringify(tail)}`);
        }
      }
    } else {
      // Unquoted: the scalar ends at " #", as YAML says. That is easy to trip over in a
      // sentence citing a ticket, so the loss is reported rather than silent.
      const trimmed = rest.replace(/\s+#.*$/, "");
      if (trimmed !== rest) {
        errors.push(`line ${ln()}: ${key} loses "${rest.slice(trimmed.length).trim()}" to a YAML comment — quote the whole value`);
      }
      data[key] = unquote(trimmed);
    }
    i++;
  }
  return { data, errors };
}

// ---------------------------------------------------------------------------
// Markdown body helpers
// ---------------------------------------------------------------------------

// [{ level, title, lines }]; the preamble before the first heading is level 0.
function splitSections(body) {
  const sections = [{ level: 0, title: "", lines: [] }];
  let inFence = false;
  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const h = !inFence && /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) sections.push({ level: h[1].length, title: h[2], lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }
  return sections;
}

function findSection(sections, re) {
  return sections.find((s) => s.level >= 2 && re.test(s.title));
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function firstLine(p) {
  try {
    return fs.readFileSync(p, "utf8").split("\n", 1)[0];
  } catch {
    return "";
  }
}

// Every child directory of the root holding an AGENTS.md or an executable.
function walkScriptDirs(root) {
  const out = [];
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith(".") || ent.name === "node_modules") continue;
    const dir = path.join(root, ent.name);
    const files = fs.readdirSync(dir);
    if (files.includes("AGENTS.md") || files.some((f) => isExecutable(path.join(dir, f)))) out.push({ name: ent.name, dir, rel: ent.name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Fields derived when a directory has no frontmatter yet (pre-migration).
function legacyDerive(entry, body) {
  const files = fs.readdirSync(entry.dir);
  const exe = files.find((f) => f === `${entry.name}.js` || f === `${entry.name}.exs`);
  const sections = splitSections(body || "");
  let summary = "";
  for (const s of sections) {
    for (const l of s.lines) {
      const t = l.trim();
      if (!t || t.startsWith("**Env:") || t.startsWith("|") || t.startsWith("```") || t.startsWith(">") || t.startsWith("<")) continue;
      summary = t.replace(/\*\*/g, "").replace(/`/g, "");
      break;
    }
    if (summary) break;
  }
  return {
    lang: exe ? path.extname(exe).slice(1) : undefined,
    entrypoint: exe,
    status: exe ? "active" : "runbook",
    tier: undefined,
    summary: summary.length > SUMMARY_MAX ? summary.slice(0, SUMMARY_MAX - 1) + "…" : summary,
    examples: [],
  };
}

function loadScript(entry) {
  const agentsPath = path.join(entry.dir, "AGENTS.md");
  const hasDoc = fs.existsSync(agentsPath);
  const text = hasDoc ? fs.readFileSync(agentsPath, "utf8") : "";
  const fm = parseFrontmatter(text);
  const problems = fm.errors.map((e) => ({ level: "error", msg: `AGENTS.md frontmatter: ${e}` }));
  if (!hasDoc) problems.push({ level: "error", msg: "no AGENTS.md" });

  const d = fm.data || {};
  const legacy = !fm.present || !fm.data;
  const derived = legacy ? legacyDerive(entry, fm.body) : {};
  const status = d.status ?? derived.status ?? "active";
  const lang = d.lang ?? derived.lang;
  const script = {
    name: d.name ?? entry.name,
    dirName: entry.name,
    dir: entry.dir,
    rel: entry.rel,
    agentsPath,
    env: d.env,
    access: d.access,
    tier: d.tier ?? derived.tier,
    status,
    lang,
    entrypoint: d.entrypoint ?? derived.entrypoint ?? (lang && !DOC_ONLY.has(status) ? `${entry.name}.${lang}` : undefined),
    also: asList(d.also),
    secrets: asList(d.secrets),
    domain: d.domain,
    country: d.country,
    integration: d.integration,
    integrator: d.integrator,
    help_flag: d.help_flag === undefined ? true : d.help_flag === true,
    summary: d.summary ?? derived.summary ?? "",
    examples: Array.isArray(d.examples) ? d.examples : derived.examples ?? [],
    reports: asList(d.reports),
    related: asList(d.related),
    blocked_on: d.blocked_on,
    retired_reason: d.retired_reason,
    retired_on: d.retired_on,
    body: fm.body,
    legacy,
    raw: text,
    problems,
    unknownKeys: Object.keys(d).filter((k) => !KNOWN_KEYS.has(k)),
  };
  script.docOnly = DOC_ONLY.has(script.status);
  script.retired = script.status === "retired";
  script.hidden = HIDDEN_STATUSES.has(script.status);
  script.exe = script.entrypoint ? path.join(script.dir, script.entrypoint) : null;
  return script;
}

const KNOWN_KEYS = new Set(["name", "summary", "domain", "country", "integration", "integrator", "env", "access", "tier", "status", "lang", "entrypoint", "also", "secrets", "help_flag", "examples", "reports", "related", "blocked_on", "retired_reason", "retired_on"]);

function asList(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------------------
// Validation (the rules `ops orion docs check` enforces)
// ---------------------------------------------------------------------------

function validateScript(s, ctx) {
  const P = [];
  const err = (msg) => P.push({ level: "error", msg });
  const warn = (msg) => P.push({ level: "warn", msg });

  if (s.legacy) {
    err("AGENTS.md has no frontmatter (run `ops orion docs check` after adding it; see `ops orion script new --help` for the template)");
    return P;
  }
  for (const k of s.unknownKeys) warn(`frontmatter: unknown key ${k}`);
  if (s.name !== s.dirName) err(`frontmatter name "${s.name}" != directory "${s.dirName}"`);
  if (!s.summary) err("frontmatter: summary is required");
  else {
    if (s.summary.length > SUMMARY_MAX) err(`frontmatter: summary is ${s.summary.length} chars (max ${SUMMARY_MAX})`);
    if (/\.\s*$/.test(s.summary)) warn("frontmatter: summary should not end with a period (gh Short style)");
  }
  if (!DOMAIN_IDS.includes(s.domain)) err(`frontmatter: domain must be one of ${DOMAIN_IDS.join(", ")}`);
  if (s.country !== undefined && !COUNTRY_RE.test(s.country)) err(`frontmatter: country must be an ISO 3166-1 alpha-2 code (ES, IT, SA), not ${s.country}`);
  for (const [key, v] of [["integration", s.integration], ["integrator", s.integrator]]) {
    if (v !== undefined && !SLUG_RE.test(v)) err(`frontmatter: ${key} must be lower_snake_case (verifactu, smart_receipts, invopop), not ${v}`);
  }
  // Only an e-invoicing tool has a country's scheme to name.
  if (s.domain !== "e-invoicing") {
    for (const key of ["country", "integration", "integrator"]) {
      if (s[key] !== undefined) warn(`frontmatter: ${key} is only meaningful with domain e-invoicing`);
    }
  }
  if (!ENVS.includes(s.env)) err(`frontmatter: env must be one of ${ENVS.join(", ")}`);
  if (!ACCESSES.includes(s.access)) err(`frontmatter: access must be one of ${ACCESSES.join(", ")}`);
  if (!TIER_IDS.includes(s.tier)) err(`frontmatter: tier must be one of ${TIER_IDS.join(", ")}`);
  if (s.access === "read-only" && s.tier && s.tier !== "read-only") err("frontmatter: access read-only requires tier read-only");
  if (!STATUSES.includes(s.status)) err(`frontmatter: status must be one of ${STATUSES.join(", ")}`);
  if (s.status === "blocked" && !s.blocked_on) err("frontmatter: status blocked requires blocked_on");
  if (s.status === "retired" && !s.retired_reason) err("frontmatter: status retired requires retired_reason (one line: what finished, and what replaces it)");
  if (s.status !== "retired" && (s.retired_reason || s.retired_on)) warn("frontmatter: retired_reason / retired_on are only meaningful with status retired");
  if (s.status !== "blocked" && s.blocked_on) warn("frontmatter: blocked_on is only meaningful with status blocked");

  if (s.docOnly) {
    if (s.lang) err("frontmatter: lang is not allowed on a doc-only (runbook/blocked) directory");
    if (s.examples.length) warn("frontmatter: examples on a doc-only directory are never runnable");
  } else {
    if (!LANGS.includes(s.lang)) err(`frontmatter: lang must be one of ${LANGS.join(", ")}`);
    if (!s.exe) err("no entrypoint");
    else checkExecutable(s.exe, s.lang, P);
    if (s.status === "active" && s.examples.length === 0) err("frontmatter: at least one example is required for an active script");
  }
  for (const ex of s.examples) {
    if (!ex || typeof ex !== "object" || typeof ex.args !== "string") err("frontmatter: each example needs `args:` (a string)");
  }
  for (const a of s.also) {
    const p = path.join(s.dir, a);
    if (!fs.existsSync(p)) err(`also: ${a} does not exist`);
    else checkExecutable(p, path.extname(a).slice(1), P, `also ${a}`);
  }
  for (const r of s.related) if (!ctx.names.has(r)) err(`related: no script named ${r}`);
  // The names of the environment variables the script reads a credential from.
  // ops asks for these before a run and passes them in; it never invents one.
  for (const name of s.secrets) {
    if (!SECRET_NAME_RE.test(name)) err(`secrets: ${name} is not an environment variable name (A-Z, digits and _)`);
  }
  if (s.docOnly && s.secrets.length) warn("frontmatter: secrets on a doc-only directory are never passed to anything");

  // legacy forms the frontmatter replaced
  if (/^\*\*Env:/m.test(s.body)) warn("body still has a `**Env:` line — frontmatter owns env/access now");
  if (findSection(splitSections(s.body), /^run it$/i)) warn("body still has a `## Run it` section — move the invocations to frontmatter `examples`");
  return P;
}

function checkExecutable(p, lang, P, label = "entrypoint") {
  if (!fs.existsSync(p)) return P.push({ level: "error", msg: `${label}: ${path.basename(p)} does not exist` });
  if (!isExecutable(p)) P.push({ level: "error", msg: `${label}: ${path.basename(p)} is not executable (chmod +x)` });
  const want = SHEBANG[lang];
  const got = firstLine(p);
  if (want && got !== want) P.push({ level: "error", msg: `${label}: first line is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}` });
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

function loadCatalogue() {
  const root = scriptsRoot();
  const scripts = walkScriptDirs(root).map(loadScript);
  const names = new Set(scripts.map((s) => s.name));
  const ctx = { names };
  const byName = new Map();
  const byAlso = new Map();
  const problems = [];
  for (const s of scripts) {
    for (const p of s.problems) problems.push({ ...p, script: s.name });
    for (const p of validateScript(s, ctx)) problems.push({ ...p, script: s.name });
    if (byName.has(s.name)) problems.push({ level: "error", script: s.name, msg: "duplicate script name" });
    byName.set(s.name, s);
    for (const a of s.also) {
      const base = path.basename(a, path.extname(a));
      if (byAlso.has(base) || names.has(base)) problems.push({ level: "error", script: s.name, msg: `also: "${base}" is already taken` });
      byAlso.set(base, { script: s, file: a });
    }
  }
  return { root, scripts, problems, byName, byAlso };
}

// name -> "<name>/<also>" -> unique also basename
function resolveTarget(cat, token) {
  const t = String(token).replace(/\/$/, "");
  if (cat.byName.has(t)) {
    const s = cat.byName.get(t);
    return { script: s, exe: s.exe, label: s.name };
  }
  const slash = t.indexOf("/");
  if (slash > 0) {
    const s = cat.byName.get(t.slice(0, slash));
    const file = t.slice(slash + 1);
    const hit = s && (s.also.find((a) => a === file || path.basename(a, path.extname(a)) === file) || (s.entrypoint === file ? s.entrypoint : null));
    if (hit) return { script: s, exe: path.join(s.dir, hit), label: `${s.name}/${hit}` };
  }
  const alsoBase = t.replace(/\.(js|exs)$/, "");
  if (cat.byAlso.has(alsoBase)) {
    const { script: s, file } = cat.byAlso.get(alsoBase);
    return { script: s, exe: path.join(s.dir, file), label: `${s.name}/${file}` };
  }
  // Live scripts first: suggesting a decommissioned one is rarely what was meant.
  const live = [...cat.byName.values()].filter((s) => !s.hidden).map((s) => s.name);
  const rest = [...cat.byName.keys(), ...cat.byAlso.keys()].filter((n) => !live.includes(n));
  const near = [...live.filter((n) => similar(n, t)), ...rest.filter((n) => similar(n, t))].slice(0, 3);
  throw new UsageError(`unknown script: ${token}`, (near.length ? `Did you mean ${near.map((n) => `"${n}"`).join(", ")}? ` : "") + "See `ops orion script list`.");
}

// Close enough to be worth suggesting: one name contains the other, or they are
// within a couple of edits of each other. A short token is not "two edits" from a
// long name just because most of the long name is missing, so lengths have to be
// comparable before the distance is even measured.
function similar(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  if (a === b) return true;
  if (b.length >= 3 && (a.includes(b) || b.includes(a))) return true;
  if (Math.abs(a.length - b.length) > 3) return false;
  return editDistance(a, b) <= Math.max(2, Math.floor(Math.max(a.length, b.length) / 6));
}

// Levenshtein, one row at a time.
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

module.exports = {
  HIDDEN_STATUSES,
  DOMAINS,
  DOMAIN_IDS,
  UNCLASSIFIED,
  domainOf,
  domainLabel,
  domainOrder,
  COUNTRY_RE,
  SLUG_RE,
  PROD_WRITE_TIERS,
  isProdWrite,
  paintTier,
  ENVS,
  ACCESSES,
  STATUSES,
  LANGS,
  SHEBANG,
  TIERS,
  TIER_IDS,
  SUMMARY_MAX,
  KNOWN_KEYS,
  SECRET_NAME_RE,
  scriptsRoot,
  parseFrontmatter,
  parseYamlSubset,
  splitSections,
  findSection,
  walkScriptDirs,
  loadScript,
  validateScript,
  loadCatalogue,
  resolveTarget,
  isExecutable,
};
