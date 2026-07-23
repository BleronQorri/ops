# confirm_sent_uat

**Env: Comarch UAT (non-prod test environment).** Processes the Comarch UAT
queue by confirming "sent" status via the edoc-online UAT REST API.

## What it does

- Talks to the edoc-online UAT API (`https://edi-uat.edoc-online.com/EdiRest`).
- Prompts for a **queue type** (`invoice` or `onboarding`) and a **Comarch JWT
  token**.
- Fetches the queue's "sent" items (`POST /api/status/sent`) for the matching
  `ConfigId` (invoice = 119208, onboarding = 119286) and confirms them.

UAT-only: the base URL is hardcoded to the UAT host — there is no production
path in this script.

## Run it

```bash
./confirm_sent_uat.js     # prompts for queue type + JWT token
```

## Prereqs

- Node on PATH (dependency-free).
- A valid Comarch UAT JWT token.
