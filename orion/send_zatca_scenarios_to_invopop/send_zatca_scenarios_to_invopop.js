#!/usr/bin/env node
"use strict";

// send_zatca_scenarios_to_invopop — build KSA invoices and credit notes on the fly
// and send them to ZATCA through an Invopop SANDBOX workspace, to see whether they
// are accepted.
//
// Self-contained on purpose: one directory, one entrypoint, no shared library.
// Helpers are copied from sibling scripts (lookup_invopop_supplier,
// ksa_fresha_vendor_switch) rather than imported.
//
// The documents are built exactly as app-accounting-documents builds them on main:
//   AccountingDocuments.EInvoicing.Invopop.SA.Zatca.InvoiceGoblBuilder        (B2B invoice)
//   AccountingDocuments.EInvoicing.Invopop.SA.Zatca.CreditNoteGoblBuilder     (B2B credit note)
//   AccountingDocuments.EInvoicing.Invopop.SA.Zatca.B2CInvoiceGoblBuilder     (simplified invoice)
//   AccountingDocuments.EInvoicing.Invopop.SA.Zatca.B2CCreditNoteGoblBuilder  (simplified credit note)
//   AccountingDocuments.EInvoicing.Invopop.SA.Zatca.PartyGoblBuilder          (supplier and customer)
// and sent the way Zatca.Invoice.dispatch_submission sends them: a draft Silo
// entry in the "invoices" folder, then a Transform job on the workspace's ZATCA
// invoice workflow. When a builder changes there, change it here.
//
// The scenarios are the document shapes in the September 2026 ZATCA shadow log
// (1,211 documents): invoice or credit note, standard (B2B) or simplified (B2C),
// 1 to 12 lines, every line standard-rated at 15%, quantity 1, no discounts —
// plus the two line shapes most likely to trip ZATCA's arithmetic: a zero-amount
// line and VAT-inclusive prices whose net is not a whole number of halalas.
// The buyers are made up; nothing from the log is copied.
//
// Never production, by two independent checks, either of which stops the run
// before anything is sent:
//   1. GET /access/v1/workspace must answer sandbox: true. The token decides the
//      workspace, so a production token is refused here whatever else is set.
//   2. The one workflow this script runs must exist in that workspace
//      (GET /transform/v1/workflows/{id}); it exists only in the sandbox.
//
// Nothing is written locally: no database, no files. What exists afterwards is the
// Silo entries and Transform jobs in the sandbox workspace, keyed
// zatca-scenario-<run>-<n>.

const crypto = require("crypto");
const readline = require("readline");
const readlinePromises = require("readline/promises");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { header: sgr("1;37"), cmd: sgr("33"), sql: sgr("36"), faint: sgr("2"), ok: sgr("32"), bad: sgr("31"), warn: sgr("1;33") };

const DEFAULT_BASE_URL = "https://api.invopop.com";
const TOKEN_ENV = "INVOPOP_SA_ZATCA_SANDBOX_API_TOKEN";
// The ZATCA invoice workflow without a webhook step, made for this test in the
// fresha_sandbox_zatca workspace: the verdict is read from the job, and no webhook
// reaches a Fresha environment with a document it never sent. Not a flag on purpose.
const WORKFLOW = "88e0b9b3-290a-4c02-98c0-47d99e637ac3";
const SUPPLIERS_FOLDER = "suppliers";
const TIMEOUT_MS = 30000;
const PAGE = 100;

// The builders' constants, verbatim.
const SCHEMA = "https://gobl.org/draft-0/bill/invoice";
const ADDONS = ["sa-zatca-v1"];
const REGIME = "SA";
const CURRENCY = "SAR";
const UNIT = "piece";
const REASON = "Refund of goods or services";
const PAYMENT_MEANS_KEY = "other";
const PAYMENT_MEANS_CODE = "42";
const PAYMENT_TERMS_KEY = "instant";
const PAYMENT_TERMS_NOTES = "Payment on receipt of invoice";
const OUTSIDE_SCOPE_VATEX = "VATEX-SA-OOS";

// --- the builders ------------------------------------------------------------

// `invoice_date` keeps its wall clock; a zero time becomes 00:00:01 because GOBL
// reads zero as "not given" and fills in the current time after Silo has hashed
// the document (GOBL-ENVELOPE-11).
function splitInvoiceDate(invoiceDate) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}:\d{2}))?/.exec(invoiceDate);
  const date = m ? m[1] : invoiceDate;
  const time = m && m[2] ? m[2] : "00:00:00";
  return [date, time === "00:00:00" ? "00:00:01" : time];
}

function totalTaxRate(taxItems) {
  const sum = (taxItems || []).reduce((acc, t) => acc + Number(t.rate), 0);
  return sum > 0 ? sum : 0;
}

// Decimal.to_string of the rate the mapper produces: "15.0", never "15".
function rateString(rate) {
  return Number.isInteger(rate) ? `${rate}.0` : String(rate);
}

function buildTax(item) {
  const rate = totalTaxRate(item.tax_items);
  if (rate > 0) return { cat: "VAT", key: "standard", percent: `${rateString(rate)}%`, ext: { "untdid-tax-category": "S" } };
  return { cat: "VAT", key: "outside-scope", ext: { "untdid-tax-category": "O", "cef-vatex": OUTSIDE_SCOPE_VATEX } };
}

function buildLines(doc) {
  return doc.items.map((item, i) => ({
    i: i + 1,
    quantity: String(item.quantity),
    item: { name: item.name, price: item.unit_gross, unit: UNIT },
    taxes: [buildTax(item)],
  }));
}

// ZATCA's national address in GOBL terms: the district is street_extra, the city locality.
function buildAddress(party, country) {
  const a = { num: party.building_number, street: party.street, street_extra: party.district, locality: party.city, region: party.province, code: party.postal_code, country };
  return Object.fromEntries(Object.entries(a).filter(([, v]) => v !== null && v !== undefined && v !== ""));
}

function buildParty(party, country) {
  return { name: party.name, identities: [{ type: "CRN", code: party.company_registration_number }], addresses: [buildAddress(party, country)] };
}

const buildSupplier = (party, country) => ({ ...buildParty(party, country), tax_id: { country, code: party.tax_number } });
const buildCustomer = (party, country) => buildParty(party, country);

const validCrn = (v) => /^\d{10}$/.test(String(v || ""));
const validTaxId = (v) => /^3\d{13}3$/.test(String(v || ""));

function addressAccepted(a) {
  if (a.country !== "SA") return Boolean(a.country);
  return Boolean(a.street && a.locality && a.street_extra) && /^\d{4}$/.test(a.num || "") && /^\d{5}$/.test(a.code || "");
}

// A simplified invoice's customer, or none: BR-10 refuses a customer without an
// address, and the addon refuses a Saudi address short of street, 4-digit building,
// 5-digit postcode, city and district. CRN and tax number go together, only when
// both are valid.
function buildB2cCustomer(party, country) {
  if (!party || !party.name) return null;
  const address = buildAddress(party, country);
  if (!addressAccepted(address)) return null;
  const customer = { name: party.name, addresses: [address] };
  if (validCrn(party.company_registration_number) && validTaxId(party.tax_number)) {
    customer.tax_id = { country: "SA", code: party.tax_number };
    customer.identities = [{ type: "CRN", code: party.company_registration_number }];
  }
  return customer;
}

function buildGobl(doc) {
  if (!doc.receipt_number) throw new Error("receipt_number is required for a ZATCA document");
  const creditNote = doc.kind === "credit_note";
  if (creditNote && !doc.previous_receipt_number) throw new Error("previous_receipt_number is required for a ZATCA credit note");
  const simplified = doc.financial_relationship_type === "b2c";
  const [issueDate, issueTime] = splitInvoiceDate(doc.invoice_date);

  const gobl = {
    $schema: SCHEMA,
    $addons: ADDONS,
    $regime: REGIME,
    ...(simplified ? { $tags: ["simplified"] } : {}),
    uuid: crypto.randomUUID(),
    type: creditNote ? "credit-note" : "standard",
    code: doc.receipt_number,
    issue_date: issueDate,
    issue_time: issueTime,
    currency: CURRENCY,
    ...(creditNote ? { preceding: [{ code: doc.previous_receipt_number, reason: REASON }] } : {}),
    tax: { prices_include: "VAT" },
    supplier: buildSupplier(doc.issuer, doc.issuer.country_code),
    ...(simplified ? {} : { customer: buildCustomer(doc.issuee, doc.issuee.country_code) }),
    delivery: { date: issueDate },
    payment: {
      instructions: { key: PAYMENT_MEANS_KEY, ext: { "untdid-payment-means": PAYMENT_MEANS_CODE } },
      terms: { key: PAYMENT_TERMS_KEY, notes: PAYMENT_TERMS_NOTES },
    },
    lines: buildLines(doc),
  };
  if (simplified) {
    const customer = buildB2cCustomer(doc.issuee, doc.issuee && doc.issuee.country_code);
    if (customer) gobl.customer = customer;
  }
  return gobl;
}

// --- the scenarios -----------------------------------------------------------

const B2B_BUYER = {
  name: "Scenario Test Salon B2B",
  tax_number: "300000000000003",
  company_registration_number: "1010000001",
  street: "King Fahd Rd",
  building_number: "1234",
  district: "Al Olaya",
  city: "Riyadh",
  postal_code: "12211",
  province: "Riyadh",
  country_code: "SA",
};

// No CRN: the mapper classifies a buyer without a valid CRN and TRN as b2c.
const B2C_BUYER = {
  name: "Scenario Test Salon B2C",
  street: "Yanbu Rd",
  building_number: "2372",
  district: "Khalid",
  city: "Yanbu",
  postal_code: "46875",
  province: "Al Madinah",
  country_code: "SA",
};

// The mapper's Item: quantity 1, unit_gross = the line's charged gross, one 15% tax item.
function line(name, gross) {
  return { name, quantity: 1, unit_gross: gross, tax_items: [{ name: "VAT", rate: 15 }] };
}

const TYPICAL = [line("Team subscription", "230.00"), line("Online payments", "47.15"), line("Fresha marketplace new clients", "115.00"), line("Google Reviews add-on", "57.50")];

const MANY = [
  line("Team subscription", "230.00"),
  line("Online payments", "61.73"),
  line("Online payment refunds", "4.12"),
  line("Fresha marketplace new clients", "86.25"),
  line("Google Reviews add-on", "57.50"),
  line("Messaging credits", "11.50"),
  line("Fresha Insights add-on", "34.50"),
  line("Client Loyalty add-on", "57.50"),
  line("Blast text messages", "3.45"),
  line("Blast emails", "2.30"),
  line("Team Chat add-on", "23.00"),
  line("Website Builder add-on", "28.75"),
];

// Gross prices whose net (gross / 1.15) is not a whole number of halalas, so the
// tax is not round(net * 15%) — 395 such lines in the shadow log.
const ROUNDING = [line("Online payments", "93.50"), line("Messaging credits", "13.37"), line("Online payment refunds", "0.99"), line("Fresha marketplace new clients", "101.01"), line("Blast emails", "7.77")];

// Ordered so a credit note always follows the invoice it cites.
const SCENARIOS = [
  { id: "b2b_invoice_1_line", note: "standard invoice, one line", kind: "invoice", rel: "b2b", lines: [line("Fresha Agreement", "575.00")] },
  { id: "b2b_invoice_4_lines", note: "standard invoice, the typical mix", kind: "invoice", rel: "b2b", lines: TYPICAL },
  { id: "b2b_invoice_12_lines", note: "standard invoice, the most lines seen", kind: "invoice", rel: "b2b", lines: MANY },
  { id: "b2b_invoice_zero_line", note: "standard invoice with a 0.00 line (111 in the log)", kind: "invoice", rel: "b2b", lines: [line("Team subscription", "230.00"), line("Online payments", "0.00"), line("Messaging credits", "11.50")] },
  { id: "b2b_invoice_rounding", note: "standard invoice, VAT-inclusive prices that do not split evenly", kind: "invoice", rel: "b2b", lines: ROUNDING },
  { id: "b2c_invoice_3_lines", note: "simplified invoice, buyer without a CRN", kind: "invoice", rel: "b2c", lines: TYPICAL.slice(0, 3) },
  { id: "b2b_credit_note", note: "standard credit note citing b2b_invoice_4_lines", kind: "credit_note", rel: "b2b", cites: "b2b_invoice_4_lines", lines: [line("Adjustment", "93.50")] },
  { id: "b2c_credit_note", note: "simplified credit note, two lines, citing b2c_invoice_3_lines", kind: "credit_note", rel: "b2c", cites: "b2c_invoice_3_lines", lines: [line("Adjustment", "47.15"), line("Adjustment", "11.50")] },
];

function scenarioDocument(scenario, issuer, numbers, date) {
  return {
    kind: scenario.kind,
    financial_relationship_type: scenario.rel,
    receipt_number: numbers[scenario.id],
    // A credit note run on its own cites a number that was never sent; ZATCA
    // takes the reference as given.
    previous_receipt_number: scenario.cites ? numbers[scenario.cites] || `INV/${numbers.run}0` : null,
    invoice_date: `${date}T00:00:00`,
    issuer,
    issuee: scenario.rel === "b2b" ? B2B_BUYER : B2C_BUYER,
    items: scenario.lines,
  };
}

// --- arguments and prompts -----------------------------------------------------

function usage() {
  return `send_zatca_scenarios_to_invopop — send made-up KSA invoices and credit notes to ZATCA through an Invopop sandbox

Usage:
  send_zatca_scenarios_to_invopop [flags] [SCENARIO...]

Arguments:
  SCENARIO               one or more of the scenarios below, or "all". Asked for on a
                         terminal when left out; required everywhere else.

Scenarios:
${SCENARIOS.map((s) => `  ${s.id.padEnd(23)}${s.note}`).join("\n")}

Flags:
      --dry-run BOOL     true (default) builds and prints the GOBL, sends nothing;
                         false sends, after a typed "yes". Asked on a terminal
      --supplier ID      the Silo entry id of the registered supplier to issue as
                         (default: asked; a lone registered supplier is taken)
      --wait N           seconds to wait for each job's verdict (default 120)
      --date YYYY-MM-DD  the invoice date (default today, UTC)
      --show-gobl        print each document's GOBL, sent or not
      --base-url URL     Invopop API base URL (default ${DEFAULT_BASE_URL})
      --json             one JSON object per document on stdout; never prompts
  -h, --help             show this help

Never production: the workspace must answer sandbox: true, and the one workflow this
script runs (${WORKFLOW}, no webhook step) must exist in it. Either failing
stops the run before anything is sent.

The token comes from $${TOKEN_ENV}, else a prompt with the echo off.

Exit codes: 0 every document sent was accepted (or the dry run built them all), 1 at
least one was rejected or had no verdict in time, 2 the call was wrong, the token
was refused or the workspace is not a sandbox.
`;
}

function fail(message, code = 1) {
  process.stderr.write(`${c.bad("✗")} ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const o = { dryRun: null, supplier: null, wait: 120, date: new Date().toISOString().slice(0, 10), showGobl: false, baseUrl: process.env.INVOPOP_API_BASE_URL || DEFAULT_BASE_URL, json: false, scenarios: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      process.stdout.write(usage());
      process.exit(0);
    } else if (a === "--dry-run") {
      const v = argv[++i];
      if (v !== "true" && v !== "false") fail("--dry-run takes true or false", 2);
      o.dryRun = v === "true";
    } else if (a === "--supplier") o.supplier = argv[++i];
    else if (a === "--wait") o.wait = Number(argv[++i]);
    else if (a === "--date") o.date = argv[++i];
    else if (a === "--show-gobl") o.showGobl = true;
    else if (a === "--base-url") o.baseUrl = argv[++i];
    else if (a === "--json") o.json = true;
    else if (a.startsWith("-")) fail(`unknown flag ${a} — see --help`, 2);
    else o.scenarios.push(a);
  }
  if (!Number.isFinite(o.wait) || o.wait < 0) fail("--wait takes a number of seconds", 2);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date || "")) fail("--date takes YYYY-MM-DD", 2);
  if (o.scenarios.includes("all")) o.scenarios = SCENARIOS.map((s) => s.id);
  const unknown = o.scenarios.filter((s) => !SCENARIOS.some((x) => x.id === s));
  if (unknown.length) fail(`unknown scenario ${unknown.join(", ")} — see --help`, 2);
  return o;
}

let RL = null;
function lines() {
  if (!RL) RL = readlinePromises.createInterface({ input: process.stdin, output: process.stderr });
  return RL;
}
function closeLines() {
  if (RL) RL.close();
  RL = null;
}

// One picker per choice: ↑↓ or j/k move, a number jumps, enter picks, esc stops.
// Copied from lookup_invopop_supplier, on stderr because stdout is this script's data.
function choose(question, options) {
  closeLines();
  const out = process.stderr;
  const row = (o, i, at) => (i === at ? `  ${c.cmd("❯")} ${c.header(o.label)}` : `    ${o.label}`) + (o.note ? c.faint(`  · ${o.note}`) : "");
  const draw = (at, first) => {
    const frame = options.map((o, i) => `${row(o, i, at)}\x1b[K`).join("\n") + "\n";
    out.write((first ? "" : `\x1b[${options.length}A\r`) + frame);
  };
  out.write(`${c.header(question)}  ${c.faint("↑↓ move · enter picks · esc stops")}\n`);
  out.write("\x1b[?25l");
  let at = 0;
  draw(at, true);
  return new Promise((resolve) => {
    const done = (fn) => {
      process.stdin.off("data", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      out.write("\x1b[?25h");
      fn();
    };
    const onKey = (buf) => {
      const before = at;
      for (const k of buf.toString().match(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|[\s\S]/g) || []) {
        if (k === "\x1b[A" || k === "\x1bOA" || k === "k") at = (at + options.length - 1) % options.length;
        else if (k === "\x1b[B" || k === "\x1bOB" || k === "j") at = (at + 1) % options.length;
        else if (/^[1-9]$/.test(k) && Number(k) <= options.length) at = Number(k) - 1;
        else if (k === "\r" || k === "\n") {
          if (at !== before) draw(at, false);
          return done(() => resolve(options[at].value));
        } else if (k === "\x1b" || k === "\x03" || k === "\x04" || k === "q") return done(() => fail("stopped at a prompt", 2));
      }
      if (at !== before) draw(at, false);
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onKey);
  });
}

async function askMissing(o) {
  const tty = process.stdin.isTTY && !o.json;
  if (!tty) {
    if (!o.scenarios.length) fail('no scenario given — name one or more, or "all"', 2);
    if (o.dryRun === false) fail("--dry-run false needs a terminal to confirm on", 2);
    o.dryRun = true;
    return;
  }
  if (!o.scenarios.length) {
    const picked = await choose("Which scenarios?", [{ value: "all", label: "all", note: `${SCENARIOS.length} documents, in order` }, ...SCENARIOS.map((s) => ({ value: s.id, label: s.id, note: s.note }))]);
    o.scenarios = picked === "all" ? SCENARIOS.map((s) => s.id) : [picked];
  }
  if (o.dryRun === null) {
    o.dryRun = await choose("Dry run?", [
      { value: true, label: "true", note: "build and print the GOBL, send nothing" },
      { value: false, label: "false", note: "send to the sandbox, after a typed yes" },
    ]);
  }
}

// One prompt, echo off, straight from the tty. Never on a piped stdin.
function askToken() {
  return new Promise((resolve) => {
    const { stdin, stderr } = process;
    if (!stdin.isTTY) return resolve(null);
    stderr.write("Paste the Invopop API token for the SA ZATCA sandbox workspace (input hidden): ");
    let buf = "";
    const done = (v) => {
      stdin.setRawMode(false);
      stdin.removeListener("data", onData);
      stdin.pause();
      stderr.write("\n");
      resolve(v);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") return done(buf.trim() || null);
        if (ch === "\x03" || ch === "\x04") return done(null);
        if (ch === "\x7f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function resolveToken(json) {
  const fromEnv = (process.env[TOKEN_ENV] || "").trim();
  if (fromEnv) return fromEnv;
  if (json || !process.stdin.isTTY) fail(`$${TOKEN_ENV} is unset and there is no terminal to ask on`, 2);
  process.stderr.write(c.faint(`$${TOKEN_ENV} is not set.\n`));
  const typed = await askToken();
  if (!typed) fail("no token given", 2);
  return typed;
}

// --- Invopop -------------------------------------------------------------------

// Answers { status, data } for every HTTP status: a 4xx on a send is a verdict to
// report, not a reason to stop. Only a refused token or no answer at all exits.
async function request(baseUrl, token, method, path, { params, body } = {}) {
  const url = new URL(path, baseUrl);
  for (const [k, v] of Object.entries(params || {})) if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS + ((params && params.wait) || 0) * 1000),
    });
  } catch (err) {
    fail(`${method} ${url.pathname} — ${err.name === "TimeoutError" ? "no answer in time" : err.message}`, 2);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text.slice(0, 500) };
  }
  if (res.status === 401 || res.status === 403) fail(`the token was refused (${res.status}) — check it opens the SA ZATCA sandbox workspace`, 2);
  return { status: res.status, data };
}

function listOf(body) {
  if (Array.isArray(body)) return body;
  for (const k of ["list", "entries", "data", "results"]) if (Array.isArray(body?.[k])) return body[k];
  return [];
}

function unwrap(m) {
  return m && typeof m === "object" ? (m.doc && typeof m.doc === "object" ? m.doc : m) : {};
}

async function requireSandbox(o, token) {
  const ws = await request(o.baseUrl, token, "GET", "/access/v1/workspace");
  if (ws.status !== 200) fail(`could not read the workspace (HTTP ${ws.status})`, 2);
  const w = ws.data || {};
  const label = `${w.name || "?"} (${w.slug || w.id || "?"}) · country ${w.country || "?"}`;
  if (w.sandbox !== true) fail(`workspace ${label} is NOT a sandbox — refusing. The token decides the workspace; use the SA ZATCA sandbox token.`, 2);
  process.stderr.write(`${c.ok("✓")} sandbox workspace ${c.header(label)}\n`);
  if (w.country && w.country !== "SA") process.stderr.write(`${c.warn("warning:")} the workspace country is ${w.country}, not SA\n`);

  const wf = await request(o.baseUrl, token, "GET", `/transform/v1/workflows/${WORKFLOW}`);
  if (wf.status === 404) fail(`workflow ${WORKFLOW} does not exist in this workspace`, 2);
  if (wf.status !== 200) fail(`could not read workflow ${WORKFLOW} (HTTP ${wf.status})`, 2);
  process.stderr.write(`${c.ok("✓")} workflow ${c.header(wf.data?.name || WORKFLOW)} ${c.faint(WORKFLOW)}\n`);
}

async function listSuppliers(o, token) {
  const seen = new Map();
  let cursor = null;
  for (;;) {
    const got = await request(o.baseUrl, token, "GET", "/silo/v1/entries", { params: { folder: SUPPLIERS_FOLDER, limit: PAGE, cursor } });
    const page = got.status === 200 ? listOf(got.data) : [];
    let fresh = 0;
    for (const e of page) {
      if (e?.id && !seen.has(e.id)) {
        seen.set(e.id, e);
        fresh++;
      }
    }
    const next = got.data?.next_cursor || got.data?.cursor;
    if (!fresh || !next || next === cursor) break;
    cursor = next;
  }
  return [...seen.values()];
}

// The supplier's GOBL org/party, mapped back onto the BillingDocument issuer the
// builders take — so the supplier block is rebuilt by the same code as production's.
function issuerFrom(entry) {
  const p = unwrap(entry.data);
  const a = (p.addresses || [])[0] || {};
  const crn = (p.identities || []).find((i) => i.type === "CRN");
  return {
    name: p.name,
    tax_number: p.tax_id?.code,
    company_registration_number: crn?.code,
    street: a.street,
    building_number: a.num,
    district: a.street_extra,
    city: a.locality,
    province: a.region,
    postal_code: a.code,
    country_code: p.tax_id?.country || a.country || "SA",
  };
}

async function pickSupplier(o, token) {
  if (o.supplier) {
    const got = await request(o.baseUrl, token, "GET", `/silo/v1/entries/${o.supplier}`);
    if (got.status !== 200) fail(`supplier entry ${o.supplier} not found in this workspace (HTTP ${got.status})`, 2);
    return got.data;
  }
  const all = await listSuppliers(o, token);
  const registered = all.filter((e) => String(e.state || "").toLowerCase() === "registered");
  if (!registered.length) {
    fail(`no registered supplier in the '${SUPPLIERS_FOLDER}' folder (${all.length} entries, none registered). ZATCA only takes documents from a supplier registered in this workspace — onboard one first.`, 1);
  }
  let chosen = registered[0];
  if (registered.length > 1) {
    if (o.json || !process.stdin.isTTY) fail(`${registered.length} registered suppliers — pick one with --supplier`, 2);
    const options = registered.map((e) => {
      const p = unwrap(e.data);
      return { value: e, label: p.name || e.id, note: `${p.tax_id?.code || "no tax id"} · ${e.id}` };
    });
    chosen = await choose("Issue as which registered supplier?", options);
  }
  if (!unwrap(chosen.data).name) {
    const got = await request(o.baseUrl, token, "GET", `/silo/v1/entries/${chosen.id}`);
    if (got.status === 200) chosen = { ...chosen, ...got.data };
  }
  return chosen;
}

// Same calls as Zatca.Invoice: a draft Silo entry in "invoices", then a job on the
// invoice workflow. `wait` is testing-only at Invopop, which is what this is.
async function send(o, token, key, gobl) {
  const entry = await request(o.baseUrl, token, "POST", "/silo/v1/entries", { body: { key, folder: "invoices", draft: true, data: gobl } });
  if (entry.status >= 300) return { verdict: "rejected", stage: "silo", http: entry.status, messages: messagesOf(entry.data) };

  const waitFor = Math.min(o.wait, 60);
  let job = await request(o.baseUrl, token, "POST", "/transform/v1/jobs", { params: { wait: waitFor }, body: { key, workflow_id: WORKFLOW, silo_entry_id: entry.data.id } });
  if (job.status >= 300) return { verdict: "rejected", stage: "job", http: job.status, entry: entry.data.id, messages: messagesOf(job.data) };

  const deadline = Date.now() + o.wait * 1000;
  while (!finished(job.data) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    job = await request(o.baseUrl, token, "GET", `/transform/v1/jobs/${job.data.id}`);
  }
  return judge(entry.data.id, job.data);
}

function finished(job) {
  return Boolean(job?.completed_at) || (job?.faults || []).length > 0 || /^(ok|ko|error|failed|completed|done)$/i.test(job?.status || "");
}

function messagesOf(body) {
  const out = [];
  if (body?.message) out.push(body.message);
  for (const f of body?.faults || []) out.push([f.provider, f.code, f.message].filter(Boolean).join(" · "));
  for (const [k, v] of Object.entries(body?.fields || {})) out.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  return out;
}

function judge(entryId, job) {
  const faults = (job?.faults || []).map((f) => [f.provider, f.code, f.message].filter(Boolean).join(" · "));
  const failedSteps = (job?.intents || []).flatMap((i) =>
    (i.events || []).filter((e) => /^(ko|err|error|failed)$/i.test(e.status || "")).map((e) => `${i.name || i.step_id}: ${[e.code, e.message].filter(Boolean).join(" · ")}`),
  );
  const base = { entry: entryId, job: job?.id, status: job?.status || null };
  if (faults.length || failedSteps.length || /^(ko|error|failed)$/i.test(job?.status || "")) return { ...base, verdict: "rejected", stage: "zatca", messages: [...faults, ...failedSteps] };
  if (!finished(job)) return { ...base, verdict: "no_verdict", messages: [`still ${job?.status || "running"} after the wait — look the job up in the console`] };
  return { ...base, verdict: "accepted", messages: [] };
}

// --- main ----------------------------------------------------------------------

async function main() {
  const o = parseArgs(process.argv.slice(2));
  await askMissing(o);
  const token = await resolveToken(o.json);
  closeLines();

  await requireSandbox(o, token);
  const supplier = await pickSupplier(o, token);
  const issuer = issuerFrom(supplier);
  process.stderr.write(`${c.ok("✓")} issuing as ${c.header(issuer.name || "?")} ${c.faint(`${issuer.tax_number || "no tax id"} · CRN ${issuer.company_registration_number || "none"} · ${supplier.id}`)}\n`);

  // Order matters: a credit note cites the invoice numbered before it in this run.
  const chosen = SCENARIOS.filter((s) => o.scenarios.includes(s.id));
  const run = new Date().toISOString().replace(/\D/g, "").slice(2, 12);
  const numbers = { run };
  chosen.forEach((s, i) => (numbers[s.id] = `${s.kind === "credit_note" ? "CN" : "INV"}/T${run}${i + 1}`));
  const docs = chosen.map((s, i) => ({ scenario: s, key: `zatca-scenario-${run}-${i + 1}`, gobl: buildGobl(scenarioDocument(s, issuer, numbers, o.date)) }));

  if (o.dryRun) {
    for (const d of docs) {
      if (o.json) process.stdout.write(JSON.stringify({ scenario: d.scenario.id, key: d.key, gobl: d.gobl }) + "\n");
      else process.stdout.write(`${c.header(d.scenario.id)} ${c.faint(d.gobl.code)}\n${JSON.stringify(d.gobl, null, 2)}\n\n`);
    }
    process.stderr.write(c.faint(`dry run: ${docs.length} document(s) built, nothing sent. --dry-run false sends them.\n`));
    return 0;
  }

  if (!o.json) {
    process.stderr.write(c.warn(`About to send ${docs.length} document(s) to ZATCA through this sandbox workspace.\n`));
    const typed = (await lines().question('Type "yes" to send: ')).trim();
    closeLines();
    if (typed !== "yes") fail("not confirmed — nothing sent", 2);
  }

  const results = [];
  for (const d of docs) {
    if (o.showGobl && !o.json) process.stdout.write(`${c.faint(JSON.stringify(d.gobl, null, 2))}\n`);
    if (!o.json) process.stderr.write(c.faint(`sending ${d.scenario.id} (${d.gobl.code})…\n`));
    const r = { scenario: d.scenario.id, number: d.gobl.code, key: d.key, ...(await send(o, token, d.key, d.gobl)) };
    results.push(r);
    if (o.json) process.stdout.write(JSON.stringify({ ...r, ...(o.showGobl ? { gobl: d.gobl } : {}) }) + "\n");
  }

  if (!o.json) {
    const mark = { accepted: c.ok("✓ accepted"), rejected: c.bad("✗ rejected"), no_verdict: c.warn("? no verdict") };
    process.stdout.write("\n");
    for (const r of results) {
      process.stdout.write(`${mark[r.verdict]}  ${c.header(r.scenario.padEnd(23))} ${r.number.padEnd(18)} ${c.faint(`entry ${r.entry || "-"} · job ${r.job || "-"}${r.stage ? ` · at ${r.stage}` : ""}`)}\n`);
      for (const m of r.messages || []) process.stdout.write(`      ${m}\n`);
    }
    const n = (v) => results.filter((r) => r.verdict === v).length;
    process.stdout.write(`\n${n("accepted")} accepted · ${n("rejected")} rejected · ${n("no_verdict")} without a verdict\n`);
  }
  return results.every((r) => r.verdict === "accepted") ? 0 : 1;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => fail(err.stack || String(err), 1),
  );
} else {
  module.exports = { buildGobl, scenarioDocument, SCENARIOS };
}
