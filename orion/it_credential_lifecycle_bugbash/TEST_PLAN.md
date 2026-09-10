<!-- The manual walk-through this script automates, kept as the reference run:
     production, 2026-09-04, provider 3086946 / plugin 541, ten cases green.
     The script computes the same dates from the day it runs; these are that day.
     Cases 12 and 13 have no automatic producer and stay manual — see the gap note. -->

# IT Smart Receipts — credential email test plan (production)

| provider id | account configuration id | plugin id | config row id |
| --- | --- | --- | --- |
| 3086946 | 550 | 541 | 13 |

State on 2026-09-04 10:40: `plugin_status: enabled`, `third_party_integration_status: enabled`
(**0a** done), and `credentials_renewed_at`, `last_email_sent_at`, `paused_sending_documents_at` all
null. Case 1 writes the first anchor, so it starts the run: no reset is needed while both stamps are
already clear.

Result column: ✅ pass, ❌ fail.

Flag `ORION_COMMERCIAL_DOCUMENTS_IT_CREDENTIAL_LIFECYCLE` must be on for that provider. The pass runs
in `accounting-documents-worker`.

## Logs

```bash
# the pass, with its counts in @payload
pup logs search --from 15m --limit 5 \
  --query 'env:production service:accounting-documents-worker "IT Smart Receipts credential lifecycle pass complete"'

# the decision for this provider only
pup logs search --from 15m --limit 5 \
  --query 'env:production service:accounting-documents-worker "IT Smart Receipts credential reminder recorded" @payload.provider_id:3086946'
```

The flag is scoped to providers 3086331 and 3086946, so every pass also logs `flag_off_count: 8`, and
plugin 537 (provider 3086331, paused, grace ends 2026-09-08) is settled alongside 541. The counts in
the tables are for **541 only** — the authoritative check per case is the second query.

## Stamps

```sql
select p.id as plugin_id, p.provider_id, p.plugin_status,
       c.credentials_renewed_at,
       (c.credentials_renewed_at + interval '90 days')::date          as expires_on,
       (c.credentials_renewed_at + interval '90 days')::date - current_date as days_left,
       c.last_email_sent_at,
       p.paused_sending_documents_at,
       (p.paused_sending_documents_at + interval '5 days')::date      as grace_ends_on,
       (p.paused_sending_documents_at + interval '5 days')::date - current_date as grace_left
  from account_configuration_plugins p
  join e_invoice_it_smart_receipts_configuration c on c.plugin_id = p.id
 where p.integration = 'smart_receipts'
   and p.id = 541
 order by p.id;
```

The email command the pass produced, as an outbox row — `timestamp` is the only index on that
table, and it is `timestamp without time zone` in UTC, so anchor on a window and cast `now()`:

```sql
select event_type, topic_name, timestamp, partition_key, length(proto_payload) as bytes
  from outbox_events
 where timestamp > (now() at time zone 'utc') - interval '20 minutes'
   and topic_name = 'email-generator.commands-v1'
 order by timestamp desc;
```

There is no provider column — the payload is protobuf `bytea`. `partition_key` is
`upper(md5('<recipient email>'))`, the only per-partner handle. Rows older than 7 days are pruned by
`delete_old_outbox_events`.

Drop the `p.id = 541` line for every Smart Receipts plugin. `days_left` and `grace_left` are calendar
days, the same arithmetic `Verdict` uses.

## Expiry emails — `plugin_status: :enabled`

| # | case | `CREDENTIALS_RENEWED_AT` | `LAST_EMAIL_SENT_AT` | expiry | days left | expect | result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0a | enable the plugin | — | — | — | — | `:enabled` + `:enabled` | ✅ |
| 1 | anchor outside the 14-day window | `2026-06-26` | `null` | 2026-09-24 | 20 | `skipped_count: 1`, no email, stamp stays null | ✅ |
| 2 | 14-day email | `2026-06-20` | `null` | 2026-09-18 | 14 | `reminded_count: 1`, email `days=14`, stamp → today | ✅ |
| 3 | a day later, no repeat (covers any day 13–8) | `2026-06-19` | *unset* | 2026-09-17 | 13 | `skipped_count: 1`, no email, stamp unchanged | ✅ |
| 5 | 7-day email | `2026-06-13` | `2026-08-28` | 2026-09-11 | 7 | `reminded_count: 1`, email `days=7` | ✅ |
| 6 | no repeat after the 7-day email (covers 6–2) | `2026-06-11` | *unset* | 2026-09-09 | 5 | `skipped_count: 1`, no email, stamp unchanged | ✅ |
| 7 | 1-day email | `2026-06-07` | `2026-08-29` | 2026-09-05 | 1 | `reminded_count: 1`, email `days=1` | ✅ |
| 8 | pause on expiry | `2026-06-06` | *unset* | 2026-09-04 | 0 | `paused_count: 1`, email `days=5`, plugin → `:paused` | ✅ |

## Grace emails — `plugin_status: :paused`, `CREDENTIALS_RENEWED_AT="null"`

| # | case | `PAUSED_SENDING_DOCUMENTS_AT` | `LAST_EMAIL_SENT_AT` | disable | grace left | expect | result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 9 | no repeat of the 5-day email | `2026-09-02` | `2026-09-02` | 2026-09-07 | 3 | `skipped_count: 1`, no email | ✅ |
| 10 | 1-day email | `2026-08-31` | `2026-08-31` | 2026-09-05 | 1 | `reminded_count: 1`, email `days=1` | ✅ |
| 11 | disable | `2026-08-30` | *unset* | 2026-09-04 | 0 | `disabled_count: 1`, `state=disabled` email | ✅ |

## Renewal emails — no automatic trigger yet

The job already renders both (`state` `renewed` / `reactivated` → template
`CommercialDocumentCredentialsRenewed`), but nothing in the app enqueues them: every automatic
enqueue goes through `Reminders.record/4`, whose only callers are `Pause` (`paused`/5), `Disable`
(`disabled`/5) and the pass (`expiring`/`paused` + days). `Verdict.t()` has no renewal verdict, and
`ResumeAfterCredentialRenewalAction` is deliberately silent — "No onboarding email — this is a
renewal". Tickets: **team-orion#575** (renewed before expiry) and **team-orion#577** (renewed during
the grace period); the reactivation case has no ticket of its own. Detail in
`it-credential-renewal-email-gap.md`.

So these two are template checks only, sent by hand. `NEXT_RENEWAL_DATE` has no agreed format yet —
the template quotes it verbatim.

| # | case | how | expect | result |
| --- | --- | --- | --- | --- |
| 12 | credentials renewed within the grace period | manual task, `credentials_renewed` | email quoting the next renewal date |  |
| 13 | reactivated after the disable | manual task, `credentials_reactivated` | email quoting the next renewal date |  |

```bash
# 12
houston task run accounting-documents-web send_einvoicing_email \
  -p PROVIDER_ID="3086946" -p EMAIL="credentials_renewed" \
  -p NEXT_RENEWAL_DATE="2026-12-03" -p OBAN_STORER_ENABLED="1"

# 13
houston task run accounting-documents-web send_einvoicing_email \
  -p PROVIDER_ID="3086946" -p EMAIL="credentials_reactivated" \
  -p NEXT_RENEWAL_DATE="2026-12-03" -p OBAN_STORER_ENABLED="1"
```

That task refuses any recipient outside `fresha.com`, so it works only while the configuration's
`created_by_employee_id` resolves to a Fresha address. It writes no domain state — no stamp, no
status — so it can run at any point in the ladder without disturbing the other cases.

## Commands

```bash
# 0a — enable both statuses (no DRY_RUN on this task)
houston task run accounting-documents-web update_account_configuration_plugin_status \
  -p ACCOUNT_CONFIGURATION_ID="550" -p PLUGIN_STATUS="enabled" \
  -p THIRD_PARTY_INTEGRATION_STATUS="enabled"

# 0 — reset, no pass
houston task run accounting-documents-web update_smart_receipts_credentials_renewed_at \
  -p ACCOUNT_CONFIGURATION_PLUGIN_ID="541" -p CREDENTIALS_RENEWED_AT="now" \
  -p LAST_EMAIL_SENT_AT="null" -p PAUSED_SENDING_DOCUMENTS_AT="null" \
  -p DRY_RUN="false" -p RUN_LIFECYCLE="false"

# 1
houston task run accounting-documents-web update_smart_receipts_credentials_renewed_at \
  -p ACCOUNT_CONFIGURATION_PLUGIN_ID="541" -p CREDENTIALS_RENEWED_AT="2026-06-26T00:00:00Z" \
  -p LAST_EMAIL_SENT_AT="null" -p DRY_RUN="false" -p RUN_LIFECYCLE="true" -p OBAN_STORER_ENABLED="1"

# 2
houston task run accounting-documents-web update_smart_receipts_credentials_renewed_at \
  -p ACCOUNT_CONFIGURATION_PLUGIN_ID="541" -p CREDENTIALS_RENEWED_AT="2026-06-20T00:00:00Z" \
  -p LAST_EMAIL_SENT_AT="null" -p DRY_RUN="false" -p RUN_LIFECYCLE="true" -p OBAN_STORER_ENABLED="1"

# 3
houston task run accounting-documents-web update_smart_receipts_credentials_renewed_at \
  -p ACCOUNT_CONFIGURATION_PLUGIN_ID="541" -p CREDENTIALS_RENEWED_AT="2026-06-19T00:00:00Z" \
  -p DRY_RUN="false" -p RUN_LIFECYCLE="true" -p OBAN_STORER_ENABLED="1"

# 5
houston task run accounting-documents-web update_smart_receipts_credentials_renewed_at \
  -p ACCOUNT_CONFIGURATION_PLUGIN_ID="541" -p CREDENTIALS_RENEWED_AT="2026-06-13T00:00:00Z" \
  -p LAST_EMAIL_SENT_AT="2026-08-28T00:00:00Z" -p DRY_RUN="false" -p RUN_LIFECYCLE="true" -p OBAN_STORER_ENABLED="1"

# 6
houston task run accounting-documents-web update_smart_receipts_credentials_renewed_at \
  -p ACCOUNT_CONFIGURATION_PLUGIN_ID="541" -p CREDENTIALS_RENEWED_AT="2026-06-11T00:00:00Z" \
  -p DRY_RUN="false" -p RUN_LIFECYCLE="true" -p OBAN_STORER_ENABLED="1"

# 7
houston task run accounting-documents-web update_smart_receipts_credentials_renewed_at \
  -p ACCOUNT_CONFIGURATION_PLUGIN_ID="541" -p CREDENTIALS_RENEWED_AT="2026-06-07T00:00:00Z" \
  -p LAST_EMAIL_SENT_AT="2026-08-29T00:00:00Z" -p DRY_RUN="false" -p RUN_LIFECYCLE="true" -p OBAN_STORER_ENABLED="1"

# 8
houston task run accounting-documents-web update_smart_receipts_credentials_renewed_at \
  -p ACCOUNT_CONFIGURATION_PLUGIN_ID="541" -p CREDENTIALS_RENEWED_AT="2026-06-06T00:00:00Z" \
  -p DRY_RUN="false" -p RUN_LIFECYCLE="true" -p OBAN_STORER_ENABLED="1"

# 9
houston task run accounting-documents-web update_smart_receipts_credentials_renewed_at \
  -p ACCOUNT_CONFIGURATION_PLUGIN_ID="541" -p CREDENTIALS_RENEWED_AT="null" \
  -p PAUSED_SENDING_DOCUMENTS_AT="2026-09-02T00:00:00Z" -p LAST_EMAIL_SENT_AT="2026-09-02T00:00:00Z" \
  -p DRY_RUN="false" -p RUN_LIFECYCLE="true" -p OBAN_STORER_ENABLED="1"

# 10
houston task run accounting-documents-web update_smart_receipts_credentials_renewed_at \
  -p ACCOUNT_CONFIGURATION_PLUGIN_ID="541" -p CREDENTIALS_RENEWED_AT="null" \
  -p PAUSED_SENDING_DOCUMENTS_AT="2026-08-31T00:00:00Z" -p LAST_EMAIL_SENT_AT="2026-08-31T00:00:00Z" \
  -p DRY_RUN="false" -p RUN_LIFECYCLE="true" -p OBAN_STORER_ENABLED="1"

# 11
houston task run accounting-documents-web update_smart_receipts_credentials_renewed_at \
  -p ACCOUNT_CONFIGURATION_PLUGIN_ID="541" -p CREDENTIALS_RENEWED_AT="null" \
  -p PAUSED_SENDING_DOCUMENTS_AT="2026-08-30T00:00:00Z" \
  -p DRY_RUN="false" -p RUN_LIFECYCLE="true" -p OBAN_STORER_ENABLED="1"
```
