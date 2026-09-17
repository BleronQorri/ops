---
name: it_credential_lifecycle_bugbash
summary: Walk one IT Smart Receipts plugin through the credential email ladder in twelve cases and judge each from the DB
domain: e-invoicing
country: IT
integration: smart_receipts
integrator: invopop
env: production
access: write
tier: prod-write-irreversible
status: retired
retired_on: 2026-09-10
retired_reason: "The bug bash it was written for ran on 2026-09-04 with all ten cases green; RENEWAL_EMAIL_GAP.md stays as the open question (team-orion#575)"
lang: js
secrets: [ORION_COMMERCIAL_DOCUMENTS_IT_CREDENTIAL]
examples:
  - args: ""
    note: asks for everything
  - args: "--plugin-id 541 --cases 1-8"
    note: a slice of the ladder
  - args: "--plugin-id 541 --dry-run"
    note: plan only, asks nothing
  - args: "--plugin-id 541 --reset"
    note: put the three stamps back to a fresh onboarding
reports: ["it-credential-lifecycle-bugbash-*.md"]
---
# it_credential_lifecycle_bugbash

Walks one IT Smart Receipts plugin through the whole credential email ladder —
**14 / 7 / 3 / 1** days before the credentials expire, the **pause**, **5 / 1** days
of grace, then the **disable** — and verifies each step from the database.

**Fully interactive.** It prompts for the environment and the target, prints the
state and the blast radius, and then asks before **every** step — including
between two cases, so you can read the mailbox and the front end before the clock
moves again. Any answer other than `yes` stops the run there. The flags only
pre-fill prompts; there is no unattended mode, and `--dry-run` is the only path
that neither writes nor asks.

Two documents sit beside the script:

- **[TEST_PLAN.md](TEST_PLAN.md)** — the manual walk-through this automates, kept as the reference
  run: production, 2026-09-04, provider 3086946 / plugin 541, ten cases green. Every case carries the
  exact anchor and stamp it used and the counts it expected. That run predates the 3-day email
  (cases 6 and 7 here); apart from that, a disagreement between the script and that table is a real
  change in behaviour. It also holds the `psql` snippets for the three stamps and
  for the outbox row, and cases 12 and 13, which stay manual.
- **[RENEWAL_EMAIL_GAP.md](RENEWAL_EMAIL_GAP.md)** — why the `renewed` and `reactivated` emails are
  not in the ladder: the job renders both, but nothing enqueues them (team-orion#575 / #577). Read it
  before adding a case for either.

Credentials live 90 days, so the ladder cannot be waited out. Each case moves the
plugin's clock with `update_smart_receipts_credentials_renewed_at`, triggers one
pass with `RUN_LIFECYCLE=true`, and then reads what the pass decided.

## The rule the script exists to enforce

`Verdict` never stores **which** email it sent. It re-derives it from
`last_email_sent_at` measured against the *current* deadline, and the deadline
comes from the anchor — `credentials_renewed_at + 90d` while enabled,
`paused_sending_documents_at + 5d` while paused.

Move the anchor alone and the previous email is re-read as the email under test,
so `due` equals `already_sent`, nothing is owed and the pass answers `:none`.
That is precisely what produced the 2026-09-04 bug-bash report *"the 14-day email
arrived, the 7-day and the 1-day never did"* — the ladder was correct, the test
was not.

So every case here writes **the anchor and the stamp together**, the stamp landing
where that case's previous email fell on the new timeline: expiry −14d before the
7-day email, expiry −7d before the 3-day one, expiry −3d before the 1-day one, the
pause day itself before the 1-day grace email. The three expiry "no repeat" cases
deliberately leave the stamp alone.

Passing `LAST_EMAIL_SENT_AT=null` everywhere would also make every email arrive,
but it re-arms the schedule instead of testing it — the no-repeat cases would
then pass vacuously. The script never does that outside `--reset`.

## How a case is judged

Not the mailbox. `Reminders.record/4` stamps `last_email_sent_at` and inserts
`SendCredentialLifecycleEmailJob` in one transaction, so that Oban row — with its
`state` and `days` args — is the exact record of the decision. Four sources are
read, in the order the send passes through them:

1. note `max(oban_jobs.id)` and the database's own clock, then run the Houston task **with `-w`**.
   That flag is not the default — without it Houston returns as soon as the Job is created and every
   read below races the write. Waiting also means a task that fails on its own terms (bad parameter,
   `:oban_storer_disabled`) fails that case immediately instead of timing out four minutes later on a
   pass that was never scheduled;
2. **the pass** — poll for the new `DetectExpiringCredentialsWorker` row to reach
   `completed` / `discarded` / `cancelled` (up to 4 minutes). This is what makes
   a "no email" verdict mean something rather than "we looked too early";
3. **the decision** — an email case wants exactly one new email job with the
   expected `state/days`, plus `last_email_sent_at` moved to today; a silent case
   wants none;
4. **the command** — the email job is polled until it finishes, then
   `outbox_events` must hold a fresh `email-generator.commands-v1` row. A job that
   ran has inserted its command, so an empty outbox means the send never left this
   service. Note Oban prunes finished jobs, so a row that vanishes between two
   reads counts as finished;
5. **the worker's own account** — `pup logs search` over
   `service:accounting-documents-worker "IT Smart Receipts credential"`, filtered
   to lines newer than this case (30 seconds of slack for clock skew, otherwise
   the previous case's reminder would fail the next silent one). It reports the
   pass counts (`reminded / skipped / paused / disabled / flag_off / failed`), and
   requires a `credential reminder recorded` **and** a `Sent IT Smart Receipts
   credential email` line for an email case, and neither for a silent one. Any
   `Failed to send …` or `lifecycle action failed` line fails the case. pup being
   absent or unauthenticated downgrades this to a warning;
6. the pause case additionally checks `paused` / `disabled`, a cleared anchor and
   a grace clock stamped today; the disable case checks the plugin is `pending`
   or `disabled` and that no document is left `not_started`;
7. the three stamps and the plugin status are printed as they now stand, then
   PASS or FAIL with each problem listed, and only then does it ask to advance.

The outbox is queried by time window because `timestamp` is its only index — it
holds UTC in a `timestamp without time zone`, so the script compares against the
database's own `now() at time zone 'utc'`. There is no provider column (the
payload is protobuf `bytea`) and `partition_key` is `upper(md5(recipient))`, which
the script cannot compute because the recipient is resolved inside the job by RPC.
The count is corroboration; the log line is the attribution.

A failing or skipped case stops the run — the ladder is sequential, and every
later case assumes the previous email landed.

The prompts, in order: environment, permission to read the plugin state, the
target (a plugin id, or `provider <id>`), "is this the plugin you mean", the
blast radius, the enable step when the plugin is not enabled or paused, which
cases to run, then per case "write these stamps and run the pass" and "continue
to case N".

## Cases

Twelve automatic cases. The renewal emails (cases 12 and 13 in `TEST_PLAN.md`) are outside the
script because no code path produces them.

| # | phase | case | clock | expects |
|---|-------|------|-------|---------|
| 1 | expiry | anchor outside the 14-day window | 20 days left, stamp cleared | nothing |
| 2 | expiry | 14-day email | 14 days left, stamp cleared | `expiring/14` |
| 3 | expiry | a day later, no repeat | 13 days left, stamp untouched | nothing (covers any day 13–8) |
| 4 | expiry | 7-day email | 7 days left, stamp at expiry −14d | `expiring/7` |
| 5 | expiry | no repeat after the 7-day email | 5 days left, stamp untouched | nothing (covers 6–4) |
| 6 | expiry | 3-day email | 3 days left, stamp at expiry −7d | `expiring/3` |
| 7 | expiry | no repeat after the 3-day email | 2 days left, stamp untouched | nothing |
| 8 | expiry | 1-day email | 1 day left, stamp at expiry −3d | `expiring/1` |
| 9 | expiry | pause on the expiry date | 0 days left | `paused/5`, plugin paused, anchor cleared |
| 10 | grace | no repeat of the grace email | 3 days of grace, stamp at the pause | nothing |
| 11 | grace | 1-day grace email | 1 day of grace, stamp at the pause | `paused/1` |
| 12 | grace | disable at the end of the grace | 0 days of grace | `disabled/5`, held documents rejected/failed |

Dates are derived from the day you run it, in UTC calendar days — the same
arithmetic as `Verdict.days_between/2`. Run each case and its pass on the same
UTC day: crossing midnight shifts every number by one and turns case 8 into a
pause.

## Danger

- **Case 12 is one-way.** It calls Invopop to deregister the supplier, marks every
  held document `rejected` / `failed`, and afterwards `SubmitCredentials` refuses a
  re-submission (`:smart_receipts_integration_not_recoverable`). The plugin needs a
  fresh onboarding, and re-onboarding the same partita IVA may hit the
  duplicate-fiscal-id branch. It asks with its own wording, and
  names how many documents it is about to reject.
- **The pass is not scoped to your plugin.** It settles *every* enabled or paused
  Smart Receipts plugin whose provider has
  `ORION_COMMERCIAL_DOCUMENTS_IT_CREDENTIAL_LIFECYCLE` on. The pre-flight prints that
  roster with each plugin's days-to-expiry and days-of-grace, so you can see who
  else a pass moves. Watch for a paused stranger — a pass can send its grace email
  or disable it.
- **The flag is easy to leave wide open.** Unleash ORs strategies, so a
  constrained `providerId` strategy is dead beside an unconstrained 100% one.
  Production carried exactly that on 2026-09-04: `flag_off_count: 0` over ten
  plugins. If the roster is long and nothing is ever skipped for the flag, check
  the strategies before running anything.
- Cases 9 to 12 write real partner-visible state. Everything writes production by
  default, so the script **refuses to run without a TTY**; `--yes` lifts that for
  `--dry-run` only, which touches nothing.

## Sales while paused

After case 9 the plugin holds documents instead of filing them: `submit_or_hold/2`
persists the accounting document and tracker and returns `{:ok, :persisted_not_sent}`
with the tracker at `not_started` and no `web_doc_id`. Handy for exercising the hold,
with two caveats — a credit note whose original was never recorded is refused before
persistence and leaves **no row at all**, and if you resume instead of disabling, the
retry cron files the backlog **for real** with the AdE within 30 minutes.

## Output

A dated `it-credential-lifecycle-bugbash-<env>-<date>.md` in the working directory:
the ids, one row per case with its clock, expectation and ✅ / ❌, and the failure
detail. Suppress with `--no-report`. Exit code is 1 if any case failed.

## Prereqs

VPN up, `houston` authenticated. Reads go through `houston psql <env>
accounting-documents` (`fresha-production-developer`), writes through `houston task
run <service>`. `pup` (`pup auth login`) is optional — without it the log checks
are skipped with a warning and the database checks still stand. Node only, no
dependencies.
