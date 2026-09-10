# IT Smart Receipts — the two renewal emails have no producer

**Regime: Italy Smart Receipts only.** Everything below lives under
`einvoicing/invopop/it/smartreceipts/`. Findings from 2026-09-04, against `main` at `d0c33f92c`.

Tickets: **team-orion#575** (renewed before expiry), **team-orion#577** (renewed during the grace
period). The reactivation email has no ticket of its own.

## What exists

`Jobs.SendCredentialLifecycleEmailJob` already handles both states — the template arm, the payload
and the RPCs are done:

| `state` | template | payload |
| --- | --- | --- |
| `expiring` / `paused` / `disabled` | `CommercialDocumentCredentialsExpiry` | `state`, `businessName`, `days`, `providerId` |
| `renewed` / `reactivated` | `CommercialDocumentCredentialsRenewed` | `state`, `nextRenewalDate`, `timezone`, `providerId` |

`send_credential_lifecycle_email_job.ex:44-45` (`@renewed_states`), `:107-119` (the payload arm).
Every field is required: the renderer rejects a nil `timezone`, which comes from Partners
`get_provider_details`.

## What is missing

Nothing enqueues either state. All automatic enqueues go through `CredentialLifecycle.Reminders.record/4`
— the single writer of `last_email_sent_at` — and it has exactly three callers:

| caller | state | days |
| --- | --- | --- |
| `Pause.maybe_open_grace_period/3` (`pause.ex:182`) | `:paused` | `grace_period_days()` = 5 |
| `Disable.record_disabled_reminder/2` (`disable.ex:56`) | `:disabled` | 5 |
| `DetectExpiringCredentialsWorker.apply_verdict/4` (`:82`) | `:expiring` or `:paused` | from the verdict |

And the verdict type cannot express a renewal at all:

```elixir
:none | {:remind, :expiring | :paused, pos_integer()} | :pause | :disable
```

The renewal path is silent on purpose. `ResumeAfterCredentialRenewalAction` re-enables the plugin,
clears `paused_sending_documents_at`, resolves the issue and releases the backlog in one
transaction, and its moduledoc states: *"No onboarding email — this is a renewal."*
`HandleRegistrationUpdate` reads a paused plugin holding a fresh `credentials_renewed_at` as a
renewal and returns `:resumed`, which stops `HandleTaxAuthorityRegistrationUpdateAction` — no
re-enable email, no application-request update, no onboarding email.

Net effect today: **a partner who renews is told nothing.** A partner who re-onboards after the
disable gets the ordinary onboarding email, not the reactivation one.

The only way to send either is by hand — `send_einvoicing_email` with `EMAIL=credentials_renewed`
or `credentials_reactivated` plus `NEXT_RENEWAL_DATE`. That task's own moduledoc already records the
gap, and notes the consequence: *"`NEXT_RENEWAL_DATE` has no established format to match. The
template quotes it as given."*

## Where a trigger would go

Both moments are already transactions that stamp the state they would announce, which is the
pattern the other five follow (enqueue inside the transaction that records the change).

- **`renewed` while paused** — `ResumeAfterCredentialRenewalAction`, the transaction that re-enables
  the plugin. Covers #577.
- **`renewed` while still enabled** — `SubmitCredentials` re-stamps `credentials_renewed_at` on a
  successful `PUT`, so a partner who renews early never pauses and never passes through the resume.
  That is #575, and it is a different call site from #577 even though the email is the same.
- **`reactivated`** — the re-onboarding path after a `Disable`, which today is a fresh onboarding.
  Whatever distinguishes "re-onboarding of a disabled Smart Receipts integration" from a first
  onboarding is what would pick this state over `onboarding_successful`.

`nextRenewalDate` is `credentials_renewed_at + credential_lifetime_days()` — available at every one
of those points, via `CredentialLifecycle.credentials_expire_at/1`.

## Questions to settle before writing it

1. **Format of `nextRenewalDate`.** No producer means no precedent. The payload is a string the
   template quotes verbatim; the `Expiry` template takes a number of days instead. A date needs the
   provider's timezone to be unambiguous, which is why `timezone` is in the same payload.
2. **Does `renewed` reuse `last_email_sent_at`?** The stamp is the reminder ladder's dedup key, and
   the ladder re-arms precisely *because* a renewal moves the anchor past the stamp. Stamping a
   renewal email into the same column would re-mute the next window's 14-day email. Most likely the
   renewal emails should not go through `Reminders.record/4` at all, but enqueue the job directly —
   which also keeps `Verdict` unchanged.
3. **One email or two states?** #575 and #577 are the same template and the same `renewed` state
   from two different call sites. Worth confirming the copy does not need to differ between "you
   renewed in time" and "you renewed while filing was held, here is the backlog".
4. **Idempotency.** `SubmitCredentials` can be called repeatedly with the same credentials. Without
   a dedup key each successful `PUT` would mail the partner again.
5. **Reactivation reachability.** After `Disable`, `SubmitCredentials` refuses with
   `:smart_receipts_integration_not_recoverable`, so reactivation means a fresh onboarding — and
   re-onboarding the same partita IVA may hit the duplicate-fiscal-id branch. Worth checking that
   the state is reachable at all before building an email for it.

## Testing

The ten automatic cases are in `it-credential-emails-test-plan.md`; cases 12 and 13 there are the
manual template checks for these two. The manual task refuses any recipient outside `fresha.com`
and writes no domain state, so it can run at any point without disturbing the ladder.
