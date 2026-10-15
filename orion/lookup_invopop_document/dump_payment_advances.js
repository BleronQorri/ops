#!/usr/bin/env node
// Print the payment.advances and totals of IT Smart Receipt silo entries, by entry UUID.
// Read-only: one GET per entry. Token: SMART_RECEIPTS_READ_ONLY_API_TOKEN.
//   ops run lookup_invopop_document/dump_payment_advances <uuid> [<uuid>...]
const token = process.env.SMART_RECEIPTS_READ_ONLY_API_TOKEN;
const baseUrl = process.env.INVOPOP_API_BASE_URL || "https://api.invopop.com";
const ids = process.argv.slice(2);
if (!token) { console.error("SMART_RECEIPTS_READ_ONLY_API_TOKEN is not set"); process.exit(2); }
if (ids.length === 0) { console.error("usage: dump_payment_advances <entry-uuid> [...]"); process.exit(2); }

(async () => {
  const out = [];
  for (const id of ids) {
    const res = await fetch(new URL(`/silo/v1/entries/${id}`, baseUrl), {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) { console.error(`${id}: ${res.status}`); process.exitCode = 1; continue; }
    const entry = await res.json();
    const doc = entry.data?.doc || entry.data || {};
    if (process.env.DEBUG_KEYS) console.error(id, Object.keys(entry), Object.keys(entry.data || {}), Object.keys(doc));
    out.push({
      id,
      state: entry.state,
      series: doc.series,
      code: doc.code,
      issue_date: doc.issue_date,
      payable: doc.totals?.payable,
      advances_total: doc.totals?.advance,
      due: doc.totals?.due,
      advances: doc.payment?.advances ?? null,
    });
  }
  console.log(JSON.stringify(out, null, 2));
})();
