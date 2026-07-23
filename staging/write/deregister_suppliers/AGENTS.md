# deregister_suppliers

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

## Run it

```bash
cd scripts/deregister_suppliers

# 1. Dry run first — walks the whole flow but POSTs nothing:
INVOPOP_API_TOKEN=<staging-token> ./deregister_suppliers.exs --dry-run

# 2. Real run — same flow + a final "yes" gate before firing:
INVOPOP_API_TOKEN=<staging-token> ./deregister_suppliers.exs
```

No token set? It prompts you to paste one. Or `export INVOPOP_API_TOKEN=...` once for the session.

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

Env: `INVOPOP_API_TOKEN` (required), `INVOPOP_API_BASE_URL` (default `https://api.invopop.com`).

## Known staging deregister workflow IDs

From `app-accounting-documents/deploy/apps/staging/values.yaml`
(`INVOPOP_ES_CONFIG` / `INVOPOP_IT_CONFIG` → `<authority>.deregister`):

| Integration | Workflow ID |
|-------------|-------------|
| ES VeriFactu | `9a5ecade-0e0a-49b0-a847-dfcef78d9d62` |
| ES TicketBAI | `7c72c919-052c-4964-9ffe-e33caa0c56be` |
| IT SmartReceipts | `a97ef713-764d-4e4e-9b3f-2e1139cde719` |

**Caveat:** these IDs are workspace-specific to Fresha's staging workspaces. If your token
points at a different sandbox workspace, pass the correct one with `--workflow-id`.

**Drift warning:** the IDs above are a hardcoded **copy** of `values.yaml` and are **not
validated at runtime**. If the deregister workflows are re-created or renamed in Invopop,
these IDs go stale and a job could be POSTed against a wrong/non-existent workflow. If a
run stops deregistering, re-copy the current IDs from `values.yaml` (or pass `--workflow-id`).
