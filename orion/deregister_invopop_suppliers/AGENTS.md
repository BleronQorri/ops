---
name: deregister_invopop_suppliers
summary: Fire the Invopop supplier-deregistration workflow, one Transform job per supplier, in a sandbox workspace
domain: e-invoicing
integrator: invopop
env: staging
access: write
tier: staging
lang: exs
secrets: [INVOPOP_SANDBOX_API_TOKEN]
examples:
  - args: ""
    note: asks whether to dry run, then for the workflow (and the token, when it is unset)
  - args: "--dry-run true"
    note: walk the whole flow, POST nothing
  - args: "--latest-only --dry-run false"
    note: one job per supplier, fired after a typed yes
  - args: "--latest-only --wait 30 --dry-run false"
    note: the same, blocking up to 30 s on each job
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

## Asking and confirming

Sandbox only, so it never asks for an environment; its banner says SANDBOX.

1. **Dry run** — a picker, `true` preselected, unless `--dry-run true|false` says
   (a bare `--dry-run` is `true`). `true` lists the jobs and POSTs nothing.
2. **Token** — a typed line, only when `INVOPOP_SANDBOX_API_TOKEN` is unset.
3. **Workflow** — a picker over the configured staging deregister workflows, the
   one suggested by the workspace's country highlighted, plus "another" to paste
   a UUID. Skipped with `--workflow-id`.
4. **`yes`** — typed once before the jobs are fired (`--dry-run false` only); the
   line names the workspace. Anything else stops the run, exit 1.

Without a terminal nothing is asked: the token must be set (exit 2 otherwise),
the workflow is `--workflow-id` or the one suggested for the country (exit 2 when
there is none), the run is a dry run, and `--dry-run false` exits 2.

## Flags

| Flag | Effect |
|------|--------|
| `--dry-run true\|false` | `true` (the default, and what a bare `--dry-run` means): plan only, POST nothing. `false`: fire the jobs after a typed `yes`. |
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
| `INVOPOP_SANDBOX_API_TOKEN` | **Required** sandbox Bearer token (or you're asked, on a terminal). |
| `INVOPOP_SANDBOX_API_BASE_URL` | Optional, default `https://api.invopop.com`. |
| `INVOPOP_DEREGISTER_WORKFLOW_ES_VERIFACTU` | Workflow UUID (staging). |
| `INVOPOP_DEREGISTER_WORKFLOW_ES_TICKETBAI` | Workflow UUID (staging). |
| `INVOPOP_DEREGISTER_WORKFLOW_IT_SMARTRECEIPTS` | Workflow UUID (staging). |

The workflow UUIDs populate the workflow picker. Any unset one just drops out of the
list — pass `--workflow-id <uuid>` to use one that isn't configured.

**Origin / drift:** the workflow UUIDs originate from
`app-accounting-documents/deploy/apps/staging/values.yaml`
(`INVOPOP_ES_CONFIG` / `INVOPOP_IT_CONFIG` → `<authority>.deregister`). They are
workspace-specific and **not validated at runtime** — if a workflow is re-created or
renamed in Invopop, refresh the value in `.env` (the shipped defaults live in
`.env.example`).
