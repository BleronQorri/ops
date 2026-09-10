---
name: confirm_sent_uat
summary: "Process the Comarch UAT queue by confirming \"sent\" items via the edoc-online UAT REST API"
env: staging
access: write
tier: staging
lang: js
aliases: [csu]
help_flag: false
examples:
  - args: ""
    note: prompts for the queue type and, unless COMARCH_UAT_JWT is set, the JWT
---
# confirm_sent_uat

## What it does

- Talks to the edoc-online UAT API (`https://edi-uat.edoc-online.com/EdiRest`).
- Prompts for a **queue type** (`invoice`, `onboarding` or `aperak`) and a
  **Comarch JWT token**.
- Fetches the queue's "sent" items (`POST /api/status/sent`) for the matching
  `ConfigId` (invoice = 119208, onboarding = 119286, aperak = 119328) and
  confirms them.

UAT-only: the base URL is hardcoded to the UAT host — there is no production
path in this script.

## Prereqs

- Node on PATH (dependency-free).
- A valid Comarch UAT JWT token.
