"use strict";

// `ops serve` — the catalogue, the runs and the schedules as one local web page.
//
// The page is where you look; the terminal is still where a script is run, for
// the same reason a timer cannot run most of them: they ask, and a browser tab
// has no terminal to ask on. What the page can do is what works without one —
// fire a schedule, remove it, stop a run — and every such button calls the same
// function the command of that name calls.
//
// Local only. The server binds 127.0.0.1 and nothing else, refuses a request
// whose Host is not this machine (the DNS-rebinding trick, where a web page you
// visit reaches your loopback through a name it controls), and takes a mutation
// only with a header a browser will not send cross-origin without a preflight
// this server never answers. It never reads .env: a run record names the secrets
// a run was given, and that is all the page ever sees.

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const ui = require("../ui");
const { UsageError } = ui;
const config = require("../config");
const cat = require("./catalogue");
const runs = require("./runs");
const schedules = require("./schedules");
const schedule = require("./schedule");
const task = require("./task");

const HOST = "127.0.0.1";
const DEFAULT_PORT = 7777;
const PAGE = path.join(__dirname, "web", "index.html");
const MUTATION_HEADER = "x-ops-local";

// --- what the page is given ---------------------------------------------------

// A script as the page sees it: the frontmatter and its paths, not the raw file.
function publicScript(s, { withBody = false } = {}) {
  const out = {
    name: s.name,
    summary: s.summary,
    domain: s.domain ?? null,
    domain_label: cat.domainLabel(cat.domainOf(s)),
    country: s.country ?? null,
    integration: s.integration ?? null,
    integrator: s.integrator ?? null,
    kind: s.kind,
    env: s.env,
    access: s.access,
    tier: s.tier ?? null,
    tier_label: s.tier ? cat.TIERS[s.tier]?.label ?? s.tier : null,
    prod_write: cat.isProdWrite(s.tier),
    status: s.status,
    status_label: cat.statusLabel(s),
    lang: s.lang,
    asks: s.asks === true,
    secrets: s.secrets || [],
    examples: s.examples || [],
    related: s.related || [],
    blocked_on: s.blocked_on ?? null,
    retired_reason: s.retired_reason ?? null,
    doc_only: Boolean(s.docOnly),
    retired: Boolean(s.retired),
    dir: s.dir,
    entrypoint: s.exe ?? null,
    problems: s.problems || [],
  };
  if (withBody) out.body = s.body || "";
  return out;
}

function catalogueView(includeRetired) {
  const catalogue = cat.loadCatalogue();
  const scripts = catalogue.scripts.filter((s) => includeRetired || !s.hidden);
  // The same order as `ops orion script list`: a section per domain and, inside
  // it, a group per integration.
  const groups = [];
  for (const domain of cat.domainOrder(scripts)) {
    const inDomain = scripts.filter((s) => cat.domainOf(s) === domain);
    for (const { group, items } of cat.integrationGroups(inDomain)) {
      groups.push({ domain, domain_label: cat.domainLabel(domain), integration: group.label, scripts: items.map((s) => publicScript(s)) });
    }
  }
  return { root: catalogue.root, problems: catalogue.problems, groups };
}

function scheduleView(rec) {
  return { ...rec, loaded: schedules.loaded(rec), last_run: schedules.lastRun(rec.name), when: schedule.whenCell(rec), log: schedules.logPath(rec.name) };
}

function runLog(rec) {
  const text = task.readLog(rec);
  return text === null ? null : task.cleanLog(text);
}

// --- the server ---------------------------------------------------------------

function send(res, status, body, type = "application/json; charset=utf-8") {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(data);
}

function notFound(res, what = "not found") {
  send(res, 404, { error: what });
}

// The request is answered only when it came to this machine by one of its own
// names. A page from elsewhere that resolves a hostname to 127.0.0.1 gets nothing.
function localHost(req, port) {
  const host = String(req.headers.host || "");
  return host === `${HOST}:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

async function handle(req, res, port) {
  if (!localHost(req, port)) return send(res, 403, { error: "ops serve answers this machine only" });
  const url = new URL(req.url, `http://${HOST}:${port}`);
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method;

  if (method === "GET" && parts.length === 0) {
    return send(res, 200, fs.readFileSync(PAGE), "text/html; charset=utf-8");
  }
  if (parts[0] !== "api") return notFound(res);

  const mutation = method === "POST" || method === "DELETE";
  if (mutation && req.headers[MUTATION_HEADER] !== "1") return send(res, 403, { error: `a mutation needs the ${MUTATION_HEADER} header` });
  if (!mutation && method !== "GET") return send(res, 405, { error: "method not allowed" });

  const [, noun, id, verb] = parts;

  if (noun === "overview" && method === "GET") {
    return send(res, 200, {
      catalogue: catalogueView(url.searchParams.get("retired") === "1"),
      runs: runs.all().slice(0, 50),
      schedules: schedules.all().map(scheduleView),
      backend: schedules.backend(),
      state_dir: runs.STATE_DIR,
      now: new Date().toISOString(),
    });
  }

  if (noun === "scripts") {
    const catalogue = cat.loadCatalogue();
    if (!id) return send(res, 200, catalogueView(url.searchParams.get("retired") === "1"));
    const s = catalogue.byName.get(id);
    if (!s) return notFound(res, `no script named ${id}`);
    return send(res, 200, publicScript(s, { withBody: true }));
  }

  if (noun === "runs") {
    if (!id) {
      let list = runs.all();
      const q = url.searchParams;
      if (q.get("script")) list = list.filter((r) => (r.script || "").toLowerCase().includes(q.get("script").toLowerCase()));
      if (q.get("status")) list = list.filter((r) => r.status === q.get("status"));
      if (q.get("schedule")) list = list.filter((r) => r.schedule === q.get("schedule"));
      const limit = Number(q.get("limit") || 100);
      return send(res, 200, list.slice(0, Number.isInteger(limit) && limit > 0 ? limit : 100));
    }
    if (!/^\d+$/.test(id)) return notFound(res, `invalid run id: ${id}`);
    const rec = runs.read(Number(id));
    if (!rec) return notFound(res, `no run with id ${id}`);
    if (verb === "log" && method === "GET") {
      const text = runLog(rec);
      return text === null ? notFound(res, rec.captured === "none" ? "no captured log (captured: none)" : "the log file is gone") : send(res, 200, text, "text/plain; charset=utf-8");
    }
    if (verb === "cancel" && method === "POST") {
      try {
        return send(res, 200, { ok: true, message: await task.doCancel(rec) });
      } catch (err) {
        if (err instanceof ui.ProblemsError) return send(res, 409, { error: err.message });
        throw err;
      }
    }
    if (!verb && method === "GET") return send(res, 200, { ...rec, log_tail: tail(runLog(rec), 40) });
    return notFound(res);
  }

  if (noun === "schedules") {
    if (!id) return send(res, 200, schedules.all().map(scheduleView));
    let rec;
    try {
      rec = schedules.read(id);
    } catch (err) {
      if (err instanceof UsageError) return notFound(res, err.message);
      throw err;
    }
    if (!rec) return notFound(res, `no schedule named ${id}`);
    if (verb === "log" && method === "GET") {
      try {
        return send(res, 200, fs.readFileSync(schedules.logPath(rec.name), "utf8"), "text/plain; charset=utf-8");
      } catch (e) {
        if (e.code === "ENOENT") return notFound(res, `${rec.name} has no timer log yet — it has not fired`);
        throw e;
      }
    }
    if (verb === "rendered" && method === "GET") return send(res, 200, schedules.rendered(rec), "text/plain; charset=utf-8");
    if (verb === "run" && method === "POST") {
      try {
        return send(res, 200, { ok: true, message: schedule.doKick(rec) });
      } catch (err) {
        if (err instanceof UsageError) return send(res, 409, { error: err.message, hint: err.hint });
        throw err;
      }
    }
    if (!verb && method === "DELETE") return send(res, 200, { ok: true, message: schedule.doRemove(rec) });
    if (!verb && method === "GET") return send(res, 200, scheduleView(rec));
    return notFound(res);
  }

  return notFound(res);
}

function tail(text, n) {
  if (text === null) return null;
  const lines = text.replace(/\n+$/, "").split("\n");
  return lines.slice(-n).join("\n");
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handle(req, res, port).catch((err) => {
        ui.eprint(`${ui.cerr.bad("error:")} ${req.method} ${req.url}: ${err.stack || err.message}`);
        if (!res.headersSent) send(res, 500, { error: err.message });
        else res.end();
      });
    });
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") reject(new UsageError(`port ${port} is already in use`, `another \`ops serve\`? pick one with --port, or \`ops config set serve.port <n>\``));
      else reject(err);
    });
    server.listen(port, HOST, () => resolve(server));
  });
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* no opener: the URL is printed anyway */
  }
}

function portFrom(flag) {
  const raw = flag ?? process.env.OPS_SERVE_PORT ?? config.get("serve.port") ?? DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new UsageError(`invalid port: ${raw}`, "a number between 1 and 65535");
  return n;
}

async function serve({ port, open = true }) {
  const server = await listen(port);
  const url = `http://${HOST}:${port}/`;
  ui.eprint(`${ui.cerr.faint("ops ▸")} serving ${ui.cerr.bold(url)} ${ui.cerr.faint("· this machine only · Ctrl-C stops it")}`);
  if (open) openBrowser(url);
  await new Promise((resolve) => {
    const stop = () => {
      ui.eprint(`${ui.cerr.faint("ops ▸")} stopped`);
      server.close(() => resolve());
      setTimeout(resolve, 500).unref();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

function register(program) {
  const { gh } = require("../program");
  const cmd = program
    .command("serve")
    .summary("Open the scripts, the runs and the schedules as a local web page")
    .description(
      "Serve one page on this machine: the catalogue as `ops orion script list` groups it, with every script's page; the run history with each run's record and log, a running one tailed live; and the schedules with their health, their runs and the confirmed counts pulled from the logs.\n\nThe page acts where a timer could — fire a schedule, remove it, stop a run — and each button calls the same function the command of that name calls. It does not run scripts: they ask on a terminal, and a browser tab has none. `ops run` stays the way to start one.\n\nLocal only: the server listens on 127.0.0.1, answers only requests addressed to this machine, and never reads .env. The page sees the names of the secrets a run was given, as `ops task get` shows them, and no values.\n\nThe port is `--port`, else OPS_SERVE_PORT, else `ops config get serve.port`, else 7777. Ctrl-C stops it."
    )
    .option("-p, --port <n>", "port to listen on (default 7777)")
    .option("--no-open", "do not open the browser")
    .helpGroup("SCRIPT COMMANDS")
    .action(async (opts) => {
      process.exitCode = await serve({ port: portFrom(opts.port), open: opts.open !== false });
    });
  gh(cmd, {
    usage: ["[flags]"],
    examples: [{ cmd: "ops serve" }, { cmd: "ops serve --port 8080 --no-open" }, { cmd: "ops config set serve.port 8080" }],
    learnMore: ["The same things in the terminal: `ops interactive`."],
  });
}

module.exports = { register, serve, handle, publicScript, catalogueView };
