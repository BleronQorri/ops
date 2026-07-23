# onboard_location_scripts

**Env: production (read + polling; task suggestions only).** Provider onboarding
check across the `shedul` and `accounting-documents` databases.

## What it does

1. **Q1 (`shedul`)** — checks the provider's `tax_number` +
   `company_registration_number` (`provider_billing_informations`).
2. **Q2 (`shedul`)** — per-location field checks
   (`location_billing_details` / `locations`): name, address, VAT number,
   company registration, etc.
3. **Suggests** the Houston onboarding tasks to run (e.g. `revoke_onboarding`,
   onboard) — it prints the exact commands but leaves running them to you.
4. **Polls** `accounting-documents` (`account_configurations` /
   `account_configuration_plugins`) after revoke/onboard tasks to confirm state.

Queries can be run directly (via `houston psql`) or pasted in manually.

## Run it

```bash
./onboard_location_scripts.exs <provider_id>
```

## Prereqs

- Elixir on PATH (`Mix.install` pulls `nimble_csv`).
- VPN + `houston` auth (production-developer) for the psql reads + polling.
