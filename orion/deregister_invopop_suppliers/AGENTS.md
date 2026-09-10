---
name: deregister_invopop_suppliers
summary: Fire the Invopop supplier-deregistration workflow, one Transform job per supplier, in a sandbox workspace
env: staging
access: write
tier: staging
lang: exs
aliases: [ds]
examples:
  - args: "--dry-run"
    note: walk the whole flow, POST nothing
  - args: ""
    note: "real run: type the workspace slug, pick the workflow, final yes"
  - args: "--latest-only --wait 30"
    note: one job per supplier, block up to 30 s each
---
# deregister_invopop_suppliers

Triggers the Invopop **supplier-deregistration** workflow for every supplier in a
workspace — one Transform job per supplier.

## What it does

Mirrors `AccountingDocuments.EInvoicing.Invopop.*.Deregister` in `app-accounting-documents`:

1. `GET /access/v1/workspace` — show the workspace the token belongs to.
2. `GET /silo/v1/entries?folder=suppliers` — list all suppliers (cursor-paginated).
3. `POST /transform/v1/jobs` with `{ "workflow_id": "<uuid>", "silo_entry_id": "<id>" }`
   — one job per supplier.

The **token selects the workspace** (there is no separate staging URL). Staging = the
token points at a **sandbox** workspace. The script **refuses to run unless
`workspace.sandbox == true`**.

## Prerequisites

- `elixir` (already pinned via `../.tool-versions`; deps are auto-installed by `Mix.install`).
- An Invopop API token for a **sandbox** workspace.

## Interactive prompts

1. **Workspace confirmation** — type the printed workspace slug to continue.
2. **Workflow pick** — `1`/`2`/`3` for the known staging deregister IDs (suggested by
   country), or paste a UUID.
3. **Final `yes`** — real run only.

## Flags

| Flag | Effect |
|------|--------|
| `--dry-run` | Plan only; POST nothing. |
| `--latest-only` | One job per supplier (latest entry). **Default: one job per silo entry** (invalidate everything). |
| `--skip-void` | Skip entries already void/cancelled. **Default: they are INCLUDED** (invalidate everything). |
| `--wait N` | Pass `?wait=N` — block up to N seconds per job. |
| `--workflow-id UUID` | Override the workflow id (see caveat below). |
| `-h`, `--help` | Full help. |

## Config (repo-root `.env`)

All values are read from the repo-root `.env` (auto-loaded; copy from `.env.example`).
Anything already in your shell env overrides `.env`.

| Var | Purpose |
|-----|---------|
| `INVOPOP_SANDBOX_API_TOKEN` | **Required** sandbox Bearer token (or you're prompted). |
| `INVOPOP_SANDBOX_API_BASE_URL` | Optional, default `https://api.invopop.com`. |
| `INVOPOP_DEREGISTER_WORKFLOW_ES_VERIFACTU` | Workflow UUID (staging). |
| `INVOPOP_DEREGISTER_WORKFLOW_ES_TICKETBAI` | Workflow UUID (staging). |
| `INVOPOP_DEREGISTER_WORKFLOW_IT_SMARTRECEIPTS` | Workflow UUID (staging). |

The workflow UUIDs populate the numbered picker. Any unset one just drops out of the
list — pass `--workflow-id <uuid>` to use one that isn't configured.

**Origin / drift:** the workflow UUIDs originate from
`app-accounting-documents/deploy/apps/staging/values.yaml`
(`INVOPOP_ES_CONFIG` / `INVOPOP_IT_CONFIG` → `<authority>.deregister`). They are
workspace-specific and **not validated at runtime** — if a workflow is re-created or
renamed in Invopop, refresh the value in `.env` (the shipped defaults live in
`.env.example`).
