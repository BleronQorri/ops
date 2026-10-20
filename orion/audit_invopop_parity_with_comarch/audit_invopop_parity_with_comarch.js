#!/usr/bin/env node
"use strict";

// audit_invopop_parity_with_comarch — replay real KSA B2B invoices through an
// Invopop SANDBOX, built with the numbers Comarch is sent, and check that what
// Invopop hands ZATCA carries the same numbers.
//
// Self-contained on purpose: one directory, one entrypoint, no shared library.
// Helpers are copied from send_zatca_scenarios_to_invopop rather than imported.
//
// 1. Reads an IssueEInvoice command export (CSV, one row per line) and keeps the
//    standard (B2B) invoices: the buyer passes KSAB2BReportability.reportable_as_b2b?.
// 2. Builds each one twice from the same BillingDocument: the way Comarch's
//    B2BInvoiceXMLBuilder does on main (InvoiceBuilderBlocks +
//    InvoiceCalculationHelper), and the way InvoiceGoblBuilder +
//    TotalsGoblBuilder do on main since #2225 (tagged `bypass`).
// 3. Sends it like Zatca.Invoice.dispatch_submission: a draft Silo entry in
//    "invoices", then a Transform job on the sandbox's webhook-less ZATCA workflow.
// 4. Waits for the job, then a few seconds more, and downloads the Silo entry and
//    its invoice.xml attachment (the UBL Invopop sent ZATCA).
// 5. Compares every amount Comarch is sent against the UBL, the QR code and the
//    Silo GOBL: parity ✅, anything else 🔴 with the fields that differ.
//
// Never production, by two independent checks, either of which stops the run
// before anything is sent:
//   1. GET /access/v1/workspace must answer sandbox: true.
//   2. The one workflow this script runs must exist in that workspace.
//
// A send writes what it downloaded to ./invopop-parity-<run>/ for a second look.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const readlinePromises = require("readline/promises");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { header: sgr("1;37"), cmd: sgr("33"), faint: sgr("2"), ok: sgr("32"), bad: sgr("31"), warn: sgr("1;33") };

const DEFAULT_BASE_URL = "https://api.invopop.com";
const TOKEN_ENV = "INVOPOP_SA_ZATCA_SANDBOX_API_TOKEN";
// The ZATCA invoice workflow without a webhook step, in fresha_sandbox_zatca: no
// Fresha environment hears about these documents. Not a flag on purpose.
const WORKFLOW = "88e0b9b3-290a-4c02-98c0-47d99e637ac3";
const SUPPLIERS_FOLDER = "suppliers";
const SIGNED_INVOICE = "invoice.xml";
const QR_STAMP = "zatca-qr";
const TIMEOUT_MS = 30000;
const PAGE = 100;

// --- decimals ------------------------------------------------------------------

// Amounts are scaled integers (micro-units) so nothing is lost to floats; Elixir's
// Decimal rounds half up, away from zero, and so does this.
const SCALE = 1000000n;

function dec(s) {
  const m = /^\s*(-?)(\d*)(?:\.(\d*))?\s*$/.exec(String(s ?? ""));
  if (!m || (m[2] === "" && !m[3])) return null;
  const frac = (m[3] || "").padEnd(7, "0");
  let v = BigInt(m[2] || "0") * SCALE + BigInt(frac.slice(0, 6));
  if (Number(frac[6]) >= 5) v += 1n;
  return m[1] ? -v : v;
}

function divRound(num, den) {
  const neg = num < 0n !== den < 0n;
  const [n, d] = [num < 0n ? -num : num, den < 0n ? -den : den];
  let q = n / d;
  if ((n % d) * 2n >= d) q += 1n;
  return neg ? -q : q;
}

function fmt(v, places) {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / SCALE;
  const frac = (a % SCALE).toString().padStart(6, "0").slice(0, places);
  return `${neg ? "-" : ""}${whole}${places ? `.${frac}` : ""}`;
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0n);
const round = (v, places) => divRound(v, 10n ** BigInt(6 - places)) * 10n ** BigInt(6 - places);

// --- the CSV ---------------------------------------------------------------------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const REQUIRED_COLUMNS = ["reference.value", "billing_document_type", "receipt_number", "invoice_date", "total_net.value", "total_gross.value", "einvoice_items.index", "einvoice_items.total_net.value", "einvoice_items.total_gross.value", "einvoice_items.unit_gross.value"];

// One BillingDocument per `reference.value`, its items in `einvoice_items.index`
// order — the shape the Comarch builders take.
function readDocuments(file) {
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const header = rows.shift() || [];
  const missing = REQUIRED_COLUMNS.filter((k) => !header.includes(k));
  if (missing.length) fail(`${file} is not an IssueEInvoice command export — missing ${missing.join(", ")}`, 2);
  const ix = Object.fromEntries(header.map((k, i) => [k, i]));
  const taxColumns = [];
  for (let n = 0; ix[`einvoice_items.tax_items.${n}.rate.value`] !== undefined; n++) taxColumns.push(n);

  const docs = new Map();
  for (const r of rows) {
    if (r.length < 2) continue;
    const g = (k) => (ix[k] === undefined ? "" : r[ix[k]]);
    const party = (side) => ({
      name: g(`${side}.reference.${side === "issuer" ? "fresha_billing_entity" : "provider"}.company_name`),
      company_registration_number: g(`${side}.business_details.ksa.company_registration_number`),
      tax_number: g(`${side}.business_details.ksa.tax_number`),
      building_number: g(`${side}.business_details.ksa.building_number`),
      district: g(`${side}.business_details.ksa.district`),
      street: g(`${side}.business_details.ksa.street`),
      city: g(`${side}.business_details.ksa.city`),
      postal_code: g(`${side}.business_details.ksa.postal_code`),
      province: g(`${side}.business_details.ksa.province`),
      country_code: g(`${side}.business_details.ksa.country`) || "SA",
    });
    const id = g("reference.value");
    let d = docs.get(id);
    if (!d) {
      d = {
        id,
        type: g("billing_document_type"),
        receipt_number: g("receipt_number"),
        invoice_date: g("invoice_date"),
        total_net: g("total_net.value"),
        total_gross: g("total_gross.value"),
        issuer: party("issuer"),
        issuee: party("issuee"),
        items: [],
      };
      docs.set(id, d);
    }
    d.items.push({
      index: Number(g("einvoice_items.index")),
      name: g("einvoice_items.name"),
      quantity: g("einvoice_items.quantity") || "1",
      total_net: g("einvoice_items.total_net.value"),
      total_gross: g("einvoice_items.total_gross.value"),
      unit_gross: g("einvoice_items.unit_gross.value"),
      tax_items: taxColumns
        .map((n) => ({ name: g(`einvoice_items.tax_items.${n}.name`), rate: g(`einvoice_items.tax_items.${n}.rate.value`), value: g(`einvoice_items.tax_items.${n}.value.value`) }))
        .filter((t) => t.rate !== ""),
    });
  }
  for (const d of docs.values()) d.items.sort((a, b) => a.index - b.index);
  return [...docs.values()];
}

// KSAB2BReportability.reportable_as_b2b?: all four fields present, a 10-character
// CRN and a 15-digit tax id starting 3 and ending 03. Anything else is downgraded
// to a simplified invoice, which this audit does not cover.
const blank = (v) => !v || !String(v).trim();
function reportableAsB2b(buyer) {
  if (["district", "building_number", "company_registration_number", "tax_number"].some((k) => blank(buyer[k]))) return false;
  return String(buyer.company_registration_number).length === 10 && /^3\d{12}03$/.test(buyer.tax_number);
}

// --- Comarch: B2BInvoiceXMLBuilder ------------------------------------------------

// InvoiceCalculationHelper.get_total_tax_rate: the summed rate, never below zero.
function totalTaxRate(taxItems) {
  const r = sum((taxItems || []).map((t) => dec(t.rate)));
  return r > 0n ? r : 0n;
}

// InvoiceCalculationHelper.calculate_unit_net_price: unit_gross / (1 + rate / 100),
// rounded to six places; a zero gross stays zero.
function unitNetPrice(item) {
  const gross = dec(item.unit_gross);
  if (gross === 0n) return 0n;
  const rate = totalTaxRate(item.tax_items);
  return divRound(gross * 100n * SCALE, 100n * SCALE + rate);
}

const category = (taxItems) => ((taxItems || []).some((t) => dec(t.rate) > 0n) ? "S" : "O");

// InvoiceBuilderBlocks.format_time: a date alone is midnight.
function splitDate(invoiceDate) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}:\d{2}))?/.exec(invoiceDate || "");
  return m ? [m[1], m[2] || "00:00:00"] : [invoiceDate, "00:00:00"];
}

// The values Comarch is sent, kept as numbers for the comparison and rendered as
// the Document-Invoice XML for a reader. Header, parties, lines and summary in the
// builder's own order; the tax summary groups by the rate's string, as
// group_tax_rates_and_sum_total_net_amount does.
function buildComarch(doc, number) {
  const [date, time] = splitDate(doc.invoice_date);
  const lines = doc.items.map((item, i) => ({
    number: i + 1,
    name: item.name,
    quantity: dec(item.quantity),
    net: dec(item.total_net),
    tax: sum(item.tax_items.map((t) => dec(t.value))),
    gross: dec(item.total_gross),
    unitNetPrice: unitNetPrice(item),
    category: category(item.tax_items),
    rate: round(totalTaxRate(item.tax_items), 2),
  }));

  const groups = new Map();
  for (const item of doc.items) {
    const taxItems = item.tax_items.length ? item.tax_items : [{ rate: "0.0", value: "0.0" }];
    for (const t of taxItems) {
      const g = groups.get(t.rate) || { rate: dec(t.rate), taxable: 0n, tax: 0n };
      g.taxable += dec(item.total_net);
      g.tax += dec(t.value);
      groups.set(t.rate, g);
    }
  }
  const summaryLines = [...groups.values()].map((g) => ({ ...g, category: g.rate === 0n ? "O" : "S", rate: round(g.rate, 2) }));

  const net = dec(doc.total_net);
  const gross = dec(doc.total_gross);
  return {
    number,
    date,
    time,
    type: "388",
    subtype: "0100000",
    buyer: { name: doc.issuee.name, crn: doc.issuee.company_registration_number },
    lines,
    net,
    taxableBasis: net,
    tax: gross - net,
    gross,
    payable: gross,
    allowance: 0n,
    prepaid: 0n,
    summaryLines,
  };
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const el = (name, value) => `<${name}>${esc(value)}</${name}>`;

function comarchXml(doc, k) {
  const party = (p, seller) =>
    [
      el("Name", p.name),
      `<Identifier>${el("Value", p.company_registration_number)}${el("Type", "CRN")}</Identifier>`,
      ...(seller ? [el("VATGroupNumber", p.tax_number), el("TaxID", p.tax_number), el("CompanyType", "multi")] : []),
      `<Address>${[["StreetAndNumber", p.street], ["BuildingNumber", p.building_number], ["CityName", p.city], ["PostalCode", p.postal_code], ["Province", p.province], ["District", p.district], ["Country", p.country_code]].map(([n, v]) => el(n, v)).join("")}</Address>`,
    ].join("");
  const line = (l) =>
    `<Line><Line-Item>${[
      el("LineNumber", l.number),
      el("ItemName", l.name),
      el("InvoiceQuantity", fmt(l.quantity, 0)),
      el("UnitOfMeasure", "PCE"),
      el("NetAmount", fmt(l.net, 2)),
      el("TaxAmount", fmt(l.tax, 2)),
      el("GrossAmount", fmt(l.gross, 2)),
      el("InvoiceUnitNetPrice", fmt(l.unitNetPrice, 6)),
      el("PriceBaseQuantity", "1"),
      el("TaxCategoryCode", l.category),
      el("TaxRate", fmt(l.rate, 2)),
      el("TaxScheme", "VAT"),
    ].join("")}</Line-Item></Line>`;
  const summaryLine = (s) =>
    `<Tax-Summary-Line>${[el("TaxableAmount", fmt(s.taxable, 2)), el("TaxAmount", fmt(s.tax, 2)), el("TaxCategoryCode", s.category), el("TaxRate", fmt(s.rate, 2))].join("")}${s.category === "O" ? el("TaxExemptionReason", "Out of Scope") + el("TaxExemptionReasonCode", "VATEX-SA-OOS") : ""}${el("TaxScheme", "VAT")}</Tax-Summary-Line>`;
  return [
    "<Document-Invoice>",
    `<Invoice-Header>${[el("InvoiceNumber", k.number), el("InvoiceDate", k.date), el("InvoiceTime", k.time), el("InvoiceType", k.type), el("InvoiceSubtype", k.subtype), el("InvoiceCurrency", "SAR"), el("TaxCurrency", "SAR"), el("BusinessProcessType", "reporting:1.0")].join("")}</Invoice-Header>`,
    `<Invoice-Parties><Seller>${party(doc.issuer, true)}</Seller><Buyer>${party(doc.issuee, false)}</Buyer></Invoice-Parties>`,
    `<Invoice-Delivery>${el("EarliestDeliveryDate", k.date)}</Invoice-Delivery>`,
    `<Invoice-Payment>${el("InvoicePaymentMeansTypeCode", "42")}</Invoice-Payment>`,
    `<Invoice-Lines>${k.lines.map(line).join("")}</Invoice-Lines>`,
    `<Invoice-Summary>${[el("TotalNetAmount", fmt(k.net, 2)), el("TotalAllowanceAmount", "0.0"), el("TotalTaxableBasis", fmt(k.taxableBasis, 2)), el("TotalTaxAmount", fmt(k.tax, 2)), el("TotalTaxAmountInTaxCurrency", fmt(k.tax, 2)), el("TotalGrossAmount", fmt(k.gross, 2)), el("TotalPrepaidAmount", "0.0"), el("TotalDuePayableAmount", fmt(k.payable, 2))].join("")}<Tax-Summary>${k.summaryLines.map(summaryLine).join("")}</Tax-Summary></Invoice-Summary>`,
    "</Document-Invoice>",
  ].join("");
}

// --- Invopop: InvoiceGoblBuilder + TotalsGoblBuilder on main (#2225, `bypass`) ------

// The GOBL is built from the same BillingDocument, the way app-accounting-documents
// builds it on main since #2225 — not from the Comarch values — so a difference
// between the two builders shows up as a 🔴. When a builder changes there, change
// it here.
//
// Elixir's Decimal keeps a scale: "655.8" prints as "655.8", a sum started from
// "0.00" prints with at least two places, a difference keeps the larger scale.
// The strings in the GOBL depend on it, so it is modelled here: { v, s } is
// v × 10^-s.
const D = (str) => {
  const m = /^\s*(-?)(\d*)(?:\.(\d*))?\s*$/.exec(String(str ?? ""));
  if (!m) throw new Error(`not a decimal: ${str}`);
  const frac = m[3] || "";
  const v = BigInt(`${m[2] || "0"}${frac}`);
  return { v: m[1] ? -v : v, s: frac.length };
};
const rescale = (a, s) => a.v * 10n ** BigInt(s - a.s);
const dAdd = (a, b) => {
  const s = Math.max(a.s, b.s);
  return { v: rescale(a, s) + rescale(b, s), s };
};
const dSub = (a, b) => dAdd(a, { v: -b.v, s: b.s });
const dStr = ({ v, s }) => {
  const neg = v < 0n;
  const digits = (neg ? -v : v).toString().padStart(s + 1, "0");
  return `${neg ? "-" : ""}${s ? `${digits.slice(0, -s)}.${digits.slice(-s)}` : digits}`;
};
const dCmp0 = (a) => (a.v > 0n ? 1 : a.v < 0n ? -1 : 0);

const OUTSIDE_SCOPE_VATEX = "VATEX-SA-OOS";

// InvoiceCalculationHelper.get_total_tax_rate: summed from "0.0", never below zero.
function totalRateDecimal(taxItems) {
  const r = (taxItems || []).reduce((acc, t) => dAdd(acc, D(t.rate)), D("0.0"));
  return dCmp0(r) > 0 ? r : D("0.0");
}

// calculate_unit_net_price: Decimal.div then Decimal.round(6), printed with six
// places; a zero gross is "0.0".
function goblUnitPrice(item) {
  if (dCmp0(D(item.unit_gross)) === 0) return "0.0";
  return fmt(unitNetPrice(item), 6);
}

// One VAT combo per line at the summed rate of its tax items.
function buildTax(item) {
  const rate = totalRateDecimal(item.tax_items);
  if (dCmp0(rate) > 0) return { cat: "VAT", key: "standard", percent: `${dStr(rate)}%`, ext: { "untdid-tax-category": "S" } };
  return { cat: "VAT", key: "outside-scope", ext: { "untdid-tax-category": "O", "cef-vatex": OUTSIDE_SCOPE_VATEX } };
}

// TotalsGoblBuilder: every amount summed from the lines, from "0.00"; a line's VAT
// is its gross less its net. Lines group by the rate's value (15.0 and 15.00 are
// one rate); the rate keeps the first line's percent string.
function buildTotals(items) {
  const add = (xs) => xs.reduce((acc, x) => dAdd(acc, x), D("0.00"));
  const groups = new Map();
  for (const item of items) {
    const combo = buildTax(item);
    const key = combo.percent ? `${combo.key}|${fmt(dec(combo.percent.replace(/%$/, "")), 6)}` : combo.key;
    if (!groups.has(key)) groups.set(key, { combo, items: [] });
    groups.get(key).items.push(item);
  }
  // A map keyed by the combo orders the smaller key (outside-scope, no percent) first.
  const ordered = [...groups.values()].sort((a, b) => Object.keys(a.combo).length - Object.keys(b.combo).length);
  const rates = ordered.map(({ combo, items: group }) => ({
    key: combo.key,
    ...(combo.percent ? { percent: combo.percent } : {}),
    ext: combo.ext,
    base: add(group.map((i) => D(i.total_net))),
    amount: add(group.map((i) => dSub(D(i.total_gross), D(i.total_net)))),
  }));
  const tax = add(rates.map((r) => r.amount));
  const net = add(items.map((i) => D(i.total_net)));
  const gross = add(items.map((i) => D(i.total_gross)));
  return {
    sum: dStr(net),
    total: dStr(net),
    taxes: { categories: [{ code: "VAT", rates: rates.map((r) => ({ ...r, base: dStr(r.base), amount: dStr(r.amount) })), amount: dStr(tax) }], sum: dStr(tax) },
    tax: dStr(tax),
    total_with_tax: dStr(gross),
    payable: dStr(gross),
  };
}

// PartyGoblBuilder: the district is street_extra, the city locality; blank keys go.
function buildAddress(party) {
  const a = { num: party.building_number, street: party.street, street_extra: party.district, locality: party.city, region: party.province, code: party.postal_code, country: party.country_code };
  return Object.fromEntries(Object.entries(a).filter(([, v]) => v !== null && v !== undefined && v !== ""));
}

const buildParty = (p) => ({ name: p.name, identities: [{ type: "CRN", code: p.company_registration_number }], addresses: [buildAddress(p)] });

// InvoiceGoblBuilder.build: a standard invoice tagged bypass. The invoice date
// keeps its wall clock; a date alone is midnight, and midnight becomes 00:00:01
// (GOBL-ENVELOPE-11).
function buildGobl(doc, number, issuer) {
  const [issueDate, time] = splitDate(doc.invoice_date);
  return {
    $schema: "https://gobl.org/draft-0/bill/invoice",
    $addons: ["sa-zatca-v1"],
    $regime: "SA",
    $tags: ["bypass"],
    uuid: crypto.randomUUID(),
    type: "standard",
    code: number,
    issue_date: issueDate,
    issue_time: time === "00:00:00" ? "00:00:01" : time,
    currency: "SAR",
    supplier: { ...buildParty(issuer), tax_id: { country: issuer.country_code, code: issuer.tax_number } },
    customer: buildParty(doc.issuee),
    delivery: { date: issueDate },
    payment: {
      instructions: { key: "other", ext: { "untdid-payment-means": "42" } },
      terms: { key: "instant", notes: "Payment on receipt of invoice" },
    },
    lines: doc.items.map((item, i) => ({
      i: i + 1,
      quantity: String(item.quantity),
      item: { name: item.name, price: goblUnitPrice(item), unit: "piece" },
      sum: dStr(D(item.total_net)),
      total: dStr(D(item.total_net)),
      taxes: [buildTax(item)],
    })),
    totals: buildTotals(doc.items),
  };
}

// --- what Invopop sent ZATCA ----------------------------------------------------

const unescape = (s) =>
  String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
const tag = (xml, name) => {
  const m = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([^<]*)</(?:\\w+:)?${name}>`).exec(xml || "");
  return m ? unescape(m[1]).trim() : null;
};
const blocks = (xml, name) => [...String(xml || "").matchAll(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "g"))].map((m) => m[1]);
const amount = (xml, name) => {
  const v = tag(xml, name);
  return v === null ? null : dec(v);
};

// The UBL Invopop hands ZATCA, read for the fields Comarch is sent. The signature
// and extensions go first: their digests are no business of a comparison.
function readUbl(xml) {
  const body = String(xml).replace(/<ext:UBLExtensions>[\s\S]*?<\/ext:UBLExtensions>/, "");
  const lines = blocks(body, "InvoiceLine");
  const head = body.replace(/<cac:InvoiceLine>[\s\S]*?<\/cac:InvoiceLine>/g, "");
  const typeCode = /<cbc:InvoiceTypeCode\b[^>]*?name="([^"]*)"[^>]*>([^<]*)</.exec(head);
  const taxTotals = blocks(head, "TaxTotal");
  const withSubtotals = taxTotals.find((t) => /TaxSubtotal/.test(t)) || "";
  const withoutSubtotals = taxTotals.find((t) => !/TaxSubtotal/.test(t)) || "";
  const totals = blocks(head, "LegalMonetaryTotal")[0] || "";
  const customer = blocks(head, "AccountingCustomerParty")[0] || "";
  const crn = /<cbc:ID\b[^>]*schemeID="CRN"[^>]*>([^<]*)</.exec(customer);
  return {
    date: tag(head, "IssueDate"),
    type: typeCode ? typeCode[2].trim() : tag(head, "InvoiceTypeCode"),
    subtype: typeCode ? typeCode[1] : null,
    buyer: { name: tag(blocks(customer, "PartyLegalEntity")[0], "RegistrationName") || tag(customer, "Name"), crn: crn ? crn[1].trim() : null },
    net: amount(totals, "LineExtensionAmount"),
    taxableBasis: amount(totals, "TaxExclusiveAmount"),
    tax: amount(withSubtotals, "TaxAmount"),
    taxInTaxCurrency: amount(withoutSubtotals, "TaxAmount"),
    gross: amount(totals, "TaxInclusiveAmount"),
    payable: amount(totals, "PayableAmount"),
    allowance: amount(totals, "AllowanceTotalAmount") ?? 0n,
    prepaid: amount(totals, "PrepaidAmount") ?? 0n,
    summaryLines: blocks(withSubtotals, "TaxSubtotal").map((s) => ({
      taxable: amount(s, "TaxableAmount"),
      tax: amount(s, "TaxAmount"),
      category: tag(s, "ID"),
      rate: amount(s, "Percent") ?? 0n,
    })),
    lines: lines.map((l) => {
      const lineTax = blocks(l, "TaxTotal")[0] || "";
      const taxCategory = blocks(l, "ClassifiedTaxCategory")[0] || "";
      return {
        number: Number(tag(l, "ID")),
        name: tag(blocks(l, "Item")[0], "Name"),
        quantity: amount(l, "InvoicedQuantity"),
        net: amount(l.replace(/<cac:TaxTotal>[\s\S]*?<\/cac:TaxTotal>/g, ""), "LineExtensionAmount"),
        tax: amount(lineTax, "TaxAmount"),
        gross: amount(lineTax, "RoundingAmount"),
        unitNetPrice: amount(blocks(l, "Price")[0], "PriceAmount"),
        category: tag(taxCategory, "ID"),
        rate: amount(taxCategory, "Percent") ?? 0n,
      };
    }),
  };
}

// The ZATCA QR is TLV: tag 4 the total with VAT, tag 5 the VAT total.
function readQr(b64) {
  const out = {};
  if (!b64) return out;
  const buf = Buffer.from(b64, "base64");
  for (let i = 0; i + 2 <= buf.length; ) {
    const t = buf[i];
    const len = buf[i + 1];
    out[t] = buf.subarray(i + 2, i + 2 + len).toString("utf8");
    i += 2 + len;
  }
  return out;
}

// --- the comparison -------------------------------------------------------------

// Every field Comarch is sent against where it lands in what Invopop sent ZATCA.
// Amounts compare as numbers, so 15.0 and 15.00 agree; text compares trimmed.
function compare(k, ubl, qr, gobl) {
  const diffs = [];
  const num = (field, want, got) => {
    if (got === null || got === undefined || want !== got) diffs.push({ field, comarch: want === null ? "—" : fmtAuto(want), invopop: got === null || got === undefined ? "missing" : fmtAuto(got) });
  };
  const text = (field, want, got) => {
    if (String(want ?? "").trim() !== String(got ?? "").trim()) diffs.push({ field, comarch: want || "—", invopop: got ?? "missing" });
  };

  text("InvoiceType", k.type, ubl.type);
  text("InvoiceSubtype", k.subtype, ubl.subtype);
  text("InvoiceDate", k.date, ubl.date);
  text("Buyer.Name", k.buyer.name, ubl.buyer.name);
  text("Buyer.CRN", k.buyer.crn, ubl.buyer.crn);

  num("TotalNetAmount", k.net, ubl.net);
  num("TotalTaxableBasis", k.taxableBasis, ubl.taxableBasis);
  num("TotalTaxAmount", k.tax, ubl.tax);
  num("TotalTaxAmountInTaxCurrency", k.tax, ubl.taxInTaxCurrency);
  num("TotalGrossAmount", k.gross, ubl.gross);
  num("TotalDuePayableAmount", k.payable, ubl.payable);
  num("TotalAllowanceAmount", k.allowance, ubl.allowance);
  num("TotalPrepaidAmount", k.prepaid, ubl.prepaid);

  text("Tax-Summary.count", String(k.summaryLines.length), String(ubl.summaryLines.length));
  for (const s of k.summaryLines) {
    const got = ubl.summaryLines.find((u) => u.category === s.category && u.rate === s.rate);
    const at = `Tax-Summary[${s.category} ${fmt(s.rate, 2)}%]`;
    if (!got) {
      diffs.push({ field: at, comarch: "present", invopop: "missing" });
      continue;
    }
    num(`${at}.TaxableAmount`, s.taxable, got.taxable);
    num(`${at}.TaxAmount`, s.tax, got.tax);
  }

  text("Lines.count", String(k.lines.length), String(ubl.lines.length));
  for (const l of k.lines) {
    const got = ubl.lines.find((u) => u.number === l.number);
    const at = `Line[${l.number}]`;
    if (!got) {
      diffs.push({ field: at, comarch: "present", invopop: "missing" });
      continue;
    }
    text(`${at}.ItemName`, l.name, got.name);
    num(`${at}.InvoiceQuantity`, l.quantity, got.quantity);
    num(`${at}.NetAmount`, l.net, got.net);
    num(`${at}.TaxAmount`, l.tax, got.tax);
    num(`${at}.GrossAmount`, l.gross, got.gross);
    num(`${at}.InvoiceUnitNetPrice`, l.unitNetPrice, got.unitNetPrice);
    text(`${at}.TaxCategoryCode`, l.category, got.category);
    num(`${at}.TaxRate`, l.rate, got.rate);
  }

  num("QR.TotalWithVAT", k.gross, qr[4] === undefined ? null : dec(qr[4]));
  num("QR.VATTotal", k.tax, qr[5] === undefined ? null : dec(qr[5]));

  const totals = gobl?.totals || {};
  num("Silo.totals.sum", k.net, totals.sum === undefined ? null : dec(totals.sum));
  num("Silo.totals.tax", k.tax, totals.tax === undefined ? null : dec(totals.tax));
  num("Silo.totals.total_with_tax", k.gross, totals.total_with_tax === undefined ? null : dec(totals.total_with_tax));
  num("Silo.totals.payable", k.payable, totals.payable === undefined ? null : dec(totals.payable));
  return diffs;
}

// The places a value needs, so 64.982609 and 64.9826 both show what they are.
function fmtAuto(v) {
  if (typeof v !== "bigint") return String(v);
  let s = fmt(v, 6);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  const dot = s.indexOf(".");
  return dot === -1 ? `${s}.00` : s.length - dot - 1 < 2 ? s.padEnd(dot + 3, "0") : s;
}

// --- arguments and prompts -----------------------------------------------------

function usage() {
  return `audit_invopop_parity_with_comarch — replay real KSA B2B invoices through an Invopop sandbox, built with
the numbers Comarch is sent, and check ZATCA gets the same numbers from Invopop

Usage:
  audit_invopop_parity_with_comarch --csv FILE [flags] [RECEIPT...]

Arguments:
  RECEIPT                receipt numbers to replay; without them the first --limit
                         standard (B2B) invoices in the file

Flags:
      --csv FILE         an IssueEInvoice command export, one row per line (asked on
                         a terminal when left out)
      --limit N          how many invoices when no RECEIPT is named (default 10)
      --offset N         skip the first N standard invoices (default 0)
      --dry-run BOOL     true (default) builds the Comarch XML and the GOBL and
                         sends nothing; false sends, after a typed "yes". Asked on a
                         terminal
      --ignore FIELDS    comma-separated field names left out of the verdict, e.g.
                         InvoiceUnitNetPrice (matches any line's)
      --supplier ID      the Silo entry id of the registered supplier to issue as
                         (default: asked; a lone registered supplier is taken)
      --wait N           seconds to wait for each job (default 120)
      --settle N         seconds to wait after a job before downloading (default 5)
      --show             print each document's Comarch XML and GOBL
      --base-url URL     Invopop API base URL (default ${DEFAULT_BASE_URL})
      --json             one JSON object per document on stdout; never prompts
  -h, --help             show this help

Only standard (B2B) invoices: a buyer that KSAB2BReportability would downgrade to
simplified is skipped, and so are credit notes, which the export cannot tie to the
invoice they credit. Each document is renumbered <receipt>-T<run> and issued as the
sandbox's registered supplier; the seller is the one field not compared.

Never production: the workspace must answer sandbox: true, and the one workflow this
script runs (${WORKFLOW}, no webhook step) must exist in it.

The token comes from $${TOKEN_ENV}, else a prompt with the echo off.

Exit codes: 0 every document is at parity (or the dry run built them all), 1 at
least one is not, 2 the call was wrong, the token was refused or the workspace is
not a sandbox.
`;
}

function fail(message, code = 1) {
  process.stderr.write(`${c.bad("✗")} ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const o = { csv: null, limit: 10, offset: 0, dryRun: null, ignore: [], supplier: null, wait: 120, settle: 5, show: false, baseUrl: process.env.INVOPOP_API_BASE_URL || DEFAULT_BASE_URL, json: false, receipts: [] };
  const count = (flag, v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) fail(`${flag} takes a whole number`, 2);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      process.stdout.write(usage());
      process.exit(0);
    } else if (a === "--csv") o.csv = argv[++i];
    else if (a === "--limit") o.limit = count(a, argv[++i]);
    else if (a === "--offset") o.offset = count(a, argv[++i]);
    else if (a === "--dry-run") {
      const v = argv[++i];
      if (v !== "true" && v !== "false") fail("--dry-run takes true or false", 2);
      o.dryRun = v === "true";
    } else if (a === "--ignore") o.ignore = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--supplier") o.supplier = argv[++i];
    else if (a === "--wait") o.wait = count(a, argv[++i]);
    else if (a === "--settle") o.settle = count(a, argv[++i]);
    else if (a === "--show") o.show = true;
    else if (a === "--base-url") o.baseUrl = argv[++i];
    else if (a === "--json") o.json = true;
    else if (a.startsWith("-")) fail(`unknown flag ${a} — see --help`, 2);
    else o.receipts.push(a);
  }
  if (o.limit === 0) fail("--limit takes at least 1", 2);
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
// Copied from send_zatca_scenarios_to_invopop, on stderr because stdout is data.
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
    if (!o.csv) fail("no --csv given", 2);
    if (o.dryRun === false) fail("--dry-run false needs a terminal to confirm on", 2);
    o.dryRun = true;
    return;
  }
  if (!o.csv) {
    o.csv = (await lines().question("Path to the IssueEInvoice command export (CSV): ")).trim().replace(/^~(?=\/)/, process.env.HOME || "~");
    if (!o.csv) fail("no CSV given", 2);
  }
  if (o.dryRun === null) {
    o.dryRun = await choose("Dry run?", [
      { value: true, label: "true", note: "build the Comarch XML and the GOBL, send nothing" },
      { value: false, label: "false", note: "send to the sandbox and compare, after a typed yes" },
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
async function request(baseUrl, token, method, urlPath, { params, body, raw } = {}) {
  const url = new URL(urlPath, baseUrl);
  for (const [k, v] of Object.entries(params || {})) if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: raw ? "*/*" : "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS + ((params && params.wait) || 0) * 1000),
    });
  } catch (err) {
    fail(`${method} ${url.pathname} — ${err.name === "TimeoutError" ? "no answer in time" : err.message}`, 2);
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) fail(`the token was refused (${res.status}) — check it opens the SA ZATCA sandbox workspace`, 2);
  if (raw) return { status: res.status, data: text };
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text.slice(0, 500) };
  }
  return { status: res.status, data };
}

function listOf(body) {
  if (Array.isArray(body)) return body;
  for (const k of ["list", "entries", "data", "results"]) if (Array.isArray(body?.[k])) return body[k];
  return [];
}

const unwrap = (m) => (m && typeof m === "object" ? (m.doc && typeof m.doc === "object" ? m.doc : m) : {});

async function requireSandbox(o, token) {
  const ws = await request(o.baseUrl, token, "GET", "/access/v1/workspace");
  if (ws.status !== 200) fail(`could not read the workspace (HTTP ${ws.status})`, 2);
  const w = ws.data || {};
  const label = `${w.name || "?"} (${w.slug || w.id || "?"}) · country ${w.country || "?"}`;
  if (w.sandbox !== true) fail(`workspace ${label} is NOT a sandbox — refusing. The token decides the workspace; use the SA ZATCA sandbox token.`, 2);
  process.stderr.write(`${c.ok("✓")} sandbox workspace ${c.header(label)}\n`);

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

// The supplier's GOBL org/party, mapped back onto the BillingDocument issuer.
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
  if (!registered.length) fail(`no registered supplier in the '${SUPPLIERS_FOLDER}' folder (${all.length} entries, none registered) — onboard one first.`, 1);
  let chosen = registered[0];
  if (registered.length > 1) {
    if (o.json || !process.stdin.isTTY) fail(`${registered.length} registered suppliers — pick one with --supplier`, 2);
    chosen = await choose(
      "Issue as which registered supplier?",
      registered.map((e) => {
        const p = unwrap(e.data);
        return { value: e, label: p.name || e.id, note: `${p.tax_id?.code || "no tax id"} · ${e.id}` };
      }),
    );
  }
  if (!unwrap(chosen.data).name) {
    const got = await request(o.baseUrl, token, "GET", `/silo/v1/entries/${chosen.id}`);
    if (got.status === 200) chosen = { ...chosen, ...got.data };
  }
  return chosen;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function judge(job) {
  const faults = (job?.faults || []).map((f) => [f.provider, f.code, f.message].filter(Boolean).join(" · "));
  const failedSteps = (job?.intents || []).flatMap((i) =>
    (i.events || []).filter((e) => /^(ko|err|error|failed)$/i.test(e.status || "")).map((e) => `${i.name || i.step_id}: ${[e.code, e.message].filter(Boolean).join(" · ")}`),
  );
  if (faults.length || failedSteps.length || /^(ko|error|failed)$/i.test(job?.status || "")) return { verdict: "rejected", messages: [...faults, ...failedSteps] };
  if (!finished(job)) return { verdict: "no_verdict", messages: [`still ${job?.status || "running"} after the wait`] };
  return { verdict: "accepted", messages: [] };
}

// Same calls as Zatca.Invoice: a draft Silo entry in "invoices", then a job on the
// invoice workflow, polled until it has a verdict.
async function send(o, token, key, gobl) {
  const entry = await request(o.baseUrl, token, "POST", "/silo/v1/entries", { body: { key, folder: "invoices", draft: true, data: gobl } });
  if (entry.status >= 300) return { verdict: "rejected", stage: "silo", messages: messagesOf(entry.data) };

  let job = await request(o.baseUrl, token, "POST", "/transform/v1/jobs", { params: { wait: Math.min(o.wait, 60) }, body: { key, workflow_id: WORKFLOW, silo_entry_id: entry.data.id } });
  if (job.status >= 300) return { verdict: "rejected", stage: "job", entry: entry.data.id, messages: messagesOf(job.data) };

  const deadline = Date.now() + o.wait * 1000;
  while (!finished(job.data) && Date.now() < deadline) {
    await sleep(3000);
    job = await request(o.baseUrl, token, "GET", `/transform/v1/jobs/${job.data.id}`);
  }
  return { entry: entry.data.id, job: job.data?.id, stage: "zatca", ...judge(job.data) };
}

// The entry as Invopop holds it after the job, and the UBL it sent ZATCA. The
// attachment can land a moment after the job closes, so it is asked for again
// for up to 20 s.
async function download(o, token, entryId) {
  await sleep(o.settle * 1000);
  const deadline = Date.now() + 20000;
  for (;;) {
    const got = await request(o.baseUrl, token, "GET", `/silo/v1/entries/${entryId}`);
    const entry = got.status === 200 ? got.data : null;
    const attachment = (entry?.attachments || []).find((a) => a.name === SIGNED_INVOICE);
    if (attachment) {
      const file = await request(o.baseUrl, token, "GET", `/silo/v1/entries/${entryId}/files/${attachment.id}`, { raw: true });
      return { entry, xml: file.status === 200 ? file.data : null };
    }
    if (Date.now() >= deadline) return { entry, xml: null };
    await sleep(2000);
  }
}

function stampOf(entry, provider) {
  return ((entry?.data?.head || {}).stamps || []).find((s) => s.prv === provider)?.val || null;
}

// --- main ----------------------------------------------------------------------

function pickDocuments(o) {
  const all = readDocuments(o.csv);
  const invoices = all.filter((d) => d.type === "INVOICE");
  const standard = invoices.filter((d) => reportableAsB2b(d.issuee));
  process.stderr.write(c.faint(`${o.csv}: ${all.length} documents, ${invoices.length} invoices, ${standard.length} standard (B2B) after KSAB2BReportability\n`));
  if (!o.receipts.length) return standard.slice(o.offset, o.offset + o.limit);
  return o.receipts.map((r) => {
    const d = all.find((x) => x.receipt_number === r);
    if (!d) fail(`receipt ${r} is not in ${o.csv}`, 2);
    if (d.type !== "INVOICE") fail(`receipt ${r} is a ${d.type.toLowerCase().replace("_", " ")} — only invoices are audited`, 2);
    if (!reportableAsB2b(d.issuee)) fail(`receipt ${r} would be downgraded to a simplified invoice — only standard (B2B) invoices are audited`, 2);
    return d;
  });
}

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

async function main() {
  const o = parseArgs(process.argv.slice(2));
  await askMissing(o);
  if (!fs.existsSync(o.csv)) fail(`${o.csv} does not exist`, 2);
  const picked = pickDocuments(o);
  if (!picked.length) fail("no standard (B2B) invoice to audit", 1);

  const token = await resolveToken(o.json);
  closeLines();
  await requireSandbox(o, token);
  const supplier = await pickSupplier(o, token);
  const issuer = issuerFrom(supplier);
  process.stderr.write(`${c.ok("✓")} issuing as ${c.header(issuer.name || "?")} ${c.faint(`${issuer.tax_number || "no tax id"} · CRN ${issuer.company_registration_number || "none"} · ${supplier.id}`)}\n`);

  const run = new Date().toISOString().replace(/\D/g, "").slice(2, 12);
  const docs = picked.map((d, i) => {
    const k = buildComarch(d, `${d.receipt_number}-T${run}`);
    return { source: d, key: `zatca-comarch-parity-${run}-${i + 1}`, comarch: k, xml: comarchXml(d, k), gobl: buildGobl(d, k.number, issuer) };
  });

  if (o.dryRun) {
    for (const d of docs) {
      const k = d.comarch;
      if (o.json) process.stdout.write(JSON.stringify({ receipt: d.source.receipt_number, number: k.number, lines: k.lines.length, net: fmt(k.net, 2), tax: fmt(k.tax, 2), gross: fmt(k.gross, 2), ...(o.show ? { comarch_xml: d.xml, gobl: d.gobl } : {}) }) + "\n");
      else {
        process.stdout.write(`${c.header(d.source.receipt_number.padEnd(10))} ${k.date}  ${String(k.lines.length).padStart(2)} lines  net ${fmt(k.net, 2).padStart(10)}  VAT ${fmt(k.tax, 2).padStart(9)}  gross ${fmt(k.gross, 2).padStart(10)}  ${c.faint(d.source.issuee.name)}\n`);
        if (o.show) process.stdout.write(`${c.faint("Comarch:")}\n${d.xml}\n${c.faint("GOBL:")}\n${JSON.stringify(d.gobl, null, 2)}\n\n`);
      }
    }
    process.stderr.write(c.faint(`dry run: ${docs.length} invoice(s) built, nothing sent. --dry-run false sends them and compares.\n`));
    return 0;
  }

  if (!o.json) {
    process.stderr.write(c.warn(`About to send ${docs.length} invoice(s) to ZATCA through this sandbox workspace.\n`));
    const typed = (await lines().question('Type "yes" to send: ')).trim();
    closeLines();
    if (typed !== "yes") fail("not confirmed — nothing sent", 2);
  }

  const outDir = path.resolve(`invopop-parity-${run}`);
  fs.mkdirSync(outDir, { recursive: true });
  const ignored = (field) => o.ignore.some((f) => field === f || field.endsWith(`.${f}`));

  const results = [];
  for (const d of docs) {
    const receipt = d.source.receipt_number;
    if (!o.json) process.stderr.write(c.faint(`sending ${receipt} as ${d.comarch.number}…\n`));
    fs.writeFileSync(path.join(outDir, `${receipt}.comarch.xml`), d.xml);
    fs.writeFileSync(path.join(outDir, `${receipt}.gobl.json`), JSON.stringify(d.gobl, null, 2));

    const sent = await send(o, token, d.key, d.gobl);
    const r = { receipt, number: d.comarch.number, key: d.key, entry: sent.entry || null, job: sent.job || null, verdict: sent.verdict, messages: sent.messages || [], diffs: [] };
    if (sent.entry) {
      const got = await download(o, token, sent.entry);
      if (got.entry) fs.writeFileSync(path.join(outDir, `${receipt}.silo.json`), JSON.stringify(got.entry, null, 2));
      if (got.xml) {
        fs.writeFileSync(path.join(outDir, `${receipt}.invopop.xml`), got.xml);
        r.diffs = compare(d.comarch, readUbl(got.xml), readQr(stampOf(got.entry, QR_STAMP)), unwrap(got.entry?.data)).filter((x) => !ignored(x.field));
      } else r.messages.push(`no ${SIGNED_INVOICE} on the entry after the wait — nothing to compare`);
    }
    r.parity = r.verdict === "accepted" && r.diffs.length === 0 && !r.messages.length;
    results.push(r);
    if (o.json) process.stdout.write(JSON.stringify(r) + "\n");
  }

  const summary = ["receipt,number,parity,verdict,field,comarch,invopop,entry"];
  for (const r of results) {
    const rows = r.diffs.length ? r.diffs : [{ field: "", comarch: "", invopop: "" }];
    for (const x of rows) summary.push([r.receipt, r.number, r.parity, r.verdict, x.field, x.comarch, x.invopop, r.entry || ""].map(csvCell).join(","));
  }
  fs.writeFileSync(path.join(outDir, "summary.csv"), summary.join("\n") + "\n");

  if (!o.json) {
    process.stdout.write("\n");
    for (const r of results) {
      process.stdout.write(`${r.parity ? "✅" : "🔴"} ${c.header(r.receipt.padEnd(10))} ${r.number.padEnd(20)} ${c.faint(`${r.verdict} · entry ${r.entry || "-"}`)}\n`);
      for (const m of r.messages) process.stdout.write(`      ${m}\n`);
      for (const x of r.diffs) process.stdout.write(`      ${x.field.padEnd(34)} comarch ${c.ok(String(x.comarch).padEnd(14))} invopop ${c.bad(x.invopop)}\n`);
    }
    const byField = new Map();
    for (const r of results) for (const x of r.diffs) byField.set(x.field.replace(/^Line\[\d+\]/, "Line[*]"), (byField.get(x.field.replace(/^Line\[\d+\]/, "Line[*]")) || 0) + 1);
    const ok = results.filter((r) => r.parity).length;
    process.stdout.write(`\n${ok} ✅ at parity · ${results.length - ok} 🔴 not\n`);
    if (byField.size) process.stdout.write(`${[...byField.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `  ${f}: ${n}`).join("\n")}\n`);
    process.stderr.write(c.faint(`downloads and summary.csv in ${outDir}\n`));
  }
  return results.every((r) => r.parity) ? 0 : 1;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => fail(err.stack || String(err), 1),
  );
} else {
  module.exports = { readDocuments, reportableAsB2b, buildComarch, comarchXml, buildGobl, readUbl, readQr, compare, dec, fmt };
}
