---
name: report_invopop_workspace_health
summary: Report an Invopop workspace's health: its suppliers, the window's documents and why the failed ones failed
domain: e-invoicing
integrator: invopop
env: production
access: read-only
tier: read-only
lang: js
secrets: [INVOPOP_ES_VERIFACTU_API_TOKEN_RO, SMART_RECEIPTS_READ_ONLY_API_TOKEN, INVOPOP_SA_ZATCA_SANDBOX_API_TOKEN, SLACK_WEBHOOK_URL]
asks: true
reports: [invopop-health-<regime>-<YYYY-MM-DD>.md, invopop-health-<regime>-<YYYY-MM-DD>.csv]
related: [check_invopop_suppliers, audit_it_smart_receipt_errors, lookup_invopop_document]
examples:
  - args: ""
    note: asks which workspace with a picker, then prints the report
  - args: "--regime verifactu"
    note: the ES Verifactu workspace, the last 24 hours
  - args: "--regime smart_receipts --since 3d --report"
    note: the IT workspace over three days, with the Markdown and CSV in the current directory
  - args: "--regime zatca_sandbox --report --notify slack"
    note: the form a daily timer runs — the report on disk and the summary in Slack
  - args: "--regime verifactu --json"
    note: the whole report as JSON; never prompts
---
# report_invopop_workspace_health

One workspace per run, one verdict per workspace: **healthy**, **degraded** or
**broken**. Three workspaces exist today, one per regime — ES Verifactu, IT Smart
Receipts and the SA ZATCA sandbox — and a timer per regime is how the health of
each one lands every morning without one workspace's trouble hiding another's.

## What it does

1. **Which workspace** — `--regime`, or a picker on a terminal. The regime picks
   the token and the token picks the workspace; the script never holds a token of
   its own.
2. **Whose it is** — `GET /access/v1/workspace`: name, slug, country and whether
   it is a sandbox. A token that is refused is a finding — the verdict is
   `broken` and the run says so — not a crash, so `ops run` offers the
   replacement it would offer for any run whose output says 401.
3. **Suppliers** — every entry in the `suppliers` folder, grouped by tax ID,
   and the newest entry decides each supplier's state: a supplier registered on
   the fourth try is registered, and its three earlier errors are history, not
   today's problem. Counted by state with the buckets the other Invopop scripts
   use (ok, pending, error, voided); the ones whose latest entry is an error are
   fetched again by id for their faults and listed. The raw states are in the
   JSON too, so a state the buckets do not know shows up by name.
4. **The window's documents** — the `invoices` folder since `--since` (default
   24h), newest first, stopping at the first whole page older than the window.
   GOBL `bill/invoice` documents only, whatever else shares the folder. Counted
   by state; the errored ones fetched again and their faults grouped and counted,
   ids and numbers blanked so one complaint about a hundred documents is one row.
5. **The verdict** — `broken` when the token was refused or every document in the
   window failed; `degraded` when any document in the window or any supplier is
   in error, or a sweep hit `--scan`; `healthy` otherwise. Exit 1 for anything but
   healthy, so a timer's run history reads as the health history.
6. **Where it goes** — the report on stdout; with `--report` a Markdown report
   and a CSV of the errored documents in the current directory; with
   `--notify slack` a summary posted to the incoming webhook in
   `SLACK_WEBHOOK_URL` (verdict, counts, top faults, the report's path).

## Safety

Read-only: GETs only, nothing is written to Invopop. `--notify slack` is the one
outbound write and it goes to a webhook you created. Without a terminal
`--regime` must be given and nothing is asked; `--json` never prompts.

## Prereqs

- The regime's token saved with `ops secrets set` — `INVOPOP_ES_VERIFACTU_API_TOKEN_RO`,
  `SMART_RECEIPTS_READ_ONLY_API_TOKEN` or `INVOPOP_SA_ZATCA_SANDBOX_API_TOKEN`.
  `ops run` asks for the ones it does not hold; Enter skips the ones another
  regime needs.
- For `--notify slack`: a Slack incoming webhook URL saved as `SLACK_WEBHOOK_URL`.
  Unset, a run with `--notify slack` fails before it reads anything, so a timer
  that cannot deliver shows up failed rather than quietly reporting to nobody.

## Output

- stdout: the verdict, the counts, why the documents failed, the errored ones
  with console links.
- `--report`: `invopop-health-<regime>-<YYYY-MM-DD>.md` and `.csv` in the
  current directory.
- Exit 0 healthy · 1 degraded or broken · 2 the call was wrong or the API could
  not be reached.

## On a timer

```
mkdir -p ~/reports/invopop-health && cd ~/reports/invopop-health
ops schedule add --name health_es --cron "0 7 * * *" report_invopop_workspace_health --regime verifactu --report --notify slack
ops schedule add --name health_it --cron "0 7 * * *" report_invopop_workspace_health --regime smart_receipts --report --notify slack
ops schedule add --name health_sa_sandbox --cron "0 7 * * *" report_invopop_workspace_health --regime zatca_sandbox --report --notify slack
```

One timer per workspace, from the directory the reports should land in.
