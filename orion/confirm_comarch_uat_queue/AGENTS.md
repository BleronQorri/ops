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
secrets: [COMARCH_UAT_JWT]
examples:
  - args: ""
    note: asks for the queue, whether to dry run and, unless COMARCH_UAT_JWT is set, the JWT
  - args: "--queue invoice --dry-run true"
    note: list the invoice queue's sent items; confirm nothing
  - args: "--queue aperak --dry-run false"
    note: confirm the aperak queue's sent items, each batch after a typed yes
---
# confirm_comarch_uat_queue

## What it does

- Talks to the edoc-online UAT API (`https://edi-uat.edoc-online.com/EdiRest`).
- Asks for the **queue** (`invoice`, `onboarding` or `aperak`) and whether to
  **dry run**, a picker each, then for the **Comarch JWT token** as a typed line
  unless `COMARCH_UAT_JWT` is set.
- Fetches the queue's "sent" items (`POST /api/status/sent`) for the matching
  `ConfigId` (invoice = 119208, onboarding = 119286, aperak = 119328) and lists
  them.
- A dry run stops there. Otherwise the listed batch is confirmed
  (`POST /api/status/sent/confirm`) after a typed `yes`, and the queue is fetched
  again until it comes back empty; any other answer stops before that batch.

## Safety

UAT-only: the base URL is hardcoded to the UAT host — there is no production
path in this script, so it asks no environment question and names Comarch UAT in
its banner. Without a terminal it asks nothing: `--queue` and `COMARCH_UAT_JWT`
must be given, and the run is a dry run.

## Prereqs

- Node on PATH (dependency-free).
- A valid Comarch UAT JWT token.
