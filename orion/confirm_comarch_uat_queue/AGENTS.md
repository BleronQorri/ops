---
name: confirm_comarch_uat_queue
summary: "Process the Comarch UAT queue by confirming \"sent\" items via the edoc-online UAT REST API"
domain: e-invoicing
country: SA
integration: zatca
integrator: comarch
env: staging
access: write
tier: staging
lang: js
secrets: [COMARCH_UAT_LOGIN, COMARCH_UAT_PASSWORD]
asks: true
examples:
  - args: ""
    note: asks for the queue and whether to dry run, each with a picker
  - args: "--queue invoice --dry-run true"
    note: list the invoice queue's sent items; confirm nothing
  - args: "--queue aperak --dry-run false"
    note: confirm the aperak queue's sent items, each batch after picking confirm or confirm all
  - args: "--queue invoice --confirm all"
    note: confirm every batch until the queue is empty without asking — the form a timer runs
---
# confirm_comarch_uat_queue

## What it does

- Talks to the edoc-online UAT API (`https://edi-uat.edoc-online.com/EdiRest`).
- Asks for the **queue** (`invoice`, `onboarding` or `aperak`) and whether to
  **dry run**, an arrow-key picker each. Nothing is typed.
- Logs in once per run (`POST /api/auth` with `COMARCH_UAT_LOGIN` and
  `COMARCH_UAT_PASSWORD`, which `ops run` asks for before the run; unset, the
  script exits 2) and keeps the JWT in memory for every batch and queue of that
  run. It is never saved, so the next run logs in again.
- Fetches the queue's "sent" items (`POST /api/status/sent`) for the matching
  `ConfigId` (invoice = 119208, onboarding = 119286, aperak = 119328) and lists
  them.
- A dry run stops there. Otherwise each listed batch gets a picker: `stop`
  (highlighted to begin with) sends nothing more, `confirm` confirms that batch
  (`POST /api/status/sent/confirm`) and asks again on the next one, and
  `confirm all` confirms it and every next batch without asking until the queue
  comes back empty. Esc stops the run. `--confirm all` is that last choice made
  up front: no picker, every batch confirmed until the queue is empty, and it
  implies `--dry-run false` — which is why it is the form `ops schedule` runs.
- When the queue was picked rather than given with `--queue`, a `What next?`
  picker follows each queue: `done` exits, `another queue` asks for the queue
  (and the dry run, unless `--dry-run` was given) again. `asks: true` makes
  `ops interactive` run it straight into these pickers.

## Safety

UAT-only: the base URL is hardcoded to the UAT host — there is no production
path in this script, so it asks no environment question and names Comarch UAT in
its banner. Without a terminal it asks nothing: `--queue` must be given, and the
run is a dry run unless `--confirm all` was given — the one flag that confirms
with nobody watching, which is acceptable because the target is UAT.

## Prereqs

- Node on PATH (dependency-free).
- The Comarch UAT login and password, saved with `ops secrets set COMARCH_UAT_LOGIN`
  and `ops secrets set COMARCH_UAT_PASSWORD`.
