# Operations

## Rollout

Each step runs in **shadow** first (`TG_MODE=shadow`): every email goes to
`TG_SHADOW_TO` only, subject prefixed `[Shadow]`, with a banner naming who it
would have gone to.

| Step                                                                        | Gate to move on                                                                                                                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Dry run (`pnpm tg run tuesday --dry-run`, a few past weeks via `--week`) | Flags match what the CSAs found by hand for the same weeks; the Task Types tab covers every code in use; every client's Ad Hoc work item is found (`karbon:check`) |
| 2. Shadow Tuesday CSA email                                                 | Two shadow Tuesdays with no wrong flags                                                                                                                            |
| 3. Shadow Friday escalation                                                 | Two shadow Fridays. "Weeks flagged" fills in over the following 4 weeks — the email says when history starts                                                       |
| 4. Shadow monthly report                                                    | One month whose numbers reconcile with Karbon's own utilization report                                                                                             |
| 5. Live                                                                     | Set `TG_MODE=live` and redeploy                                                                                                                                    |

Switching shadow → live does not re-send anything already sent live, and a
shadow send never blocks the live one (sends are keyed by mode).

The **Email {name}** buttons in a shadow email open drafts addressed to the
real people — that is the point of the trial (check the wording), but a draft
only goes out if you press Send. The banner says so.

## Day to day

**Status.** `pnpm tg status` — mode, integrations, roster size and last
upload, the last 10 runs.

**Roster changes** (new hire, leaver, new manager, CSA reassignment, holiday
list, a new task type): edit the workbook, then
`pnpm tg roster:import roster.xlsx` to preview the changes and
`… --apply` to save. An upload replaces the whole roster, so always edit the
latest copy. Problems (bad email, duplicate, unknown status, a task type
listed twice with different categories) reject the file with row numbers;
warnings don't block.

**Looking someone up.** `pnpm tg history riley` shows that person's
weekly record for the last 52 weeks (`--all` for everything kept) and their
escalation totals: last 4 weeks, this year, all time. It finds past staff
too, by the name recorded each week. `pnpm tg history --export 2026`
writes that year's workbook (Summary, Weekly detail, Escalations) to `out/`
for performance reviews — it holds staff performance data, so keep it out of
shared folders.

**"Open timesheet" links stop opening the right page:** Karbon has moved its
web route. Open any timesheet in Karbon, copy the new address, swap the
timesheet key for `{key}`, update `KARBON_TIMESHEET_URL` and redeploy;
`pnpm tg karbon:check` prints a link to confirm. Blank the setting to turn the
links off.

**Leavers:** set Status to Inactive rather than deleting the row — inactive
people are skipped, and the row keeps their history readable.

**New task type in Karbon:** the next Tuesday admin summary lists it under
"Task types not on the Task Types tab". Its time still counts toward the
person's weekly total, but not as billable, non-billable, PTO or sick until
it is added.

## When something goes wrong

**Missed-run alerts.** Every hour, and whenever the worker starts, it checks
that each job's latest 9:00 run has a successful record. If not (an hour after
the slot), `TG_ADMIN_TO` gets one email — "Missed run: Tuesday review, week of
Sep 21" — saying what the record shows (no run at all, a failure and its error,
or a run that never finished) and the exact command to run it now. One email
per missed run, never repeated hourly; it never re-runs a job itself.
`pnpm tg status` lists the same missed runs.

What it can't see: a worker that is down can't send anything, so a run missed
during an outage is reported when the worker comes back up (the check runs on
start) — and only each job's most recent run is checked, so an outage spanning
two Tuesdays reports the latest one. For the outage itself, use the host's own
monitoring — Replit's deployment monitoring, or Azure Monitor on Azure. A job
is watched only once it has run at least once, so a first deploy doesn't alert
about runs from before it existed. A run started in the last two hours that
is still going (e.g. a re-run by hand) counts as in progress, not missed. In shadow mode the alert goes
to `TG_SHADOW_TO`, like every other email.

**A scheduled run failed or the worker was down.** Run it by hand, where the
worker runs — the Replit Shell, or `az containerapp exec` on Azure. It covers
the same period the schedule would have. (A laptop set to `TG_MODE=off`
refuses a real run: it would record the run as done while sending nothing.)

```sh
pnpm tg run tuesday                 # last Monday–Sunday
pnpm tg run friday
pnpm tg run monthly                 # last month
pnpm tg run tuesday --week 2026-09-21   # a specific week
```

Re-running is always safe: every email is claimed before it is sent, so
anything that already went out is skipped (`already_sent`).

**A send failed** (`failed` in the run output or admin summary): SendGrid
refused it (a 4xx — bad key, unverified sender), nothing was sent, and the
claim was released — fix the cause, re-run the job and only that email goes
out.

**A send is `in_doubt`:** the request to SendGrid was cut off mid-flight or
SendGrid answered with a 5xx, so it may or may not have been delivered. A
re-run also reports `in_doubt` (not `already_sent`) for any send whose
earlier attempt never finished — e.g. the worker was restarted mid-send. It is NOT retried automatically
(that could double-send). Check SendGrid's activity feed; if it did not go
out, delete its row from `email_sends` (status `sending`) and re-run.

**"sent, but recording it failed"** (or "posted, but …"): the email or note
went out, but the database write after it failed. Nothing to resend — the
claim is kept so a re-run never sends it twice (that re-run will show it as
`in_doubt`). Fix the database problem; if you want the record tidy, set that
`email_sends` / `karbon_notes` row's status to `sent` / `posted`.

**Karbon errors.** 429 and 5xx responses are retried with backoff
(honouring `Retry-After`); a 4xx (bad credentials, no permission) fails the
run at once. `pnpm tg karbon:check` isolates which call fails.

**The CLI says "not configured".** It names the missing setting —
`DATABASE_URL`, `KARBON_API_KEY`/`KARBON_API_SECRET`,
`SENDGRID_API_KEY`/`SENDGRID_FROM_EMAIL`, or `TG_SHADOW_TO` in shadow mode.

## Karbon governance notes

Optional; off until `TG_KARBON_NOTES` is set. See the README for what is
posted where.

**Set up in Karbon (once):**

1. Create a client type **Governance** (like the internal type), so these
   clients can be excluded from client counts, lists and analytics.
2. Create one client of that type per CSA (e.g. "Time Governance – CSA-1"),
   one for the Partners, one per manager who should have one, and one for the
   shadow trial. Set each to **Hidden** and its client team to just the people
   who should see it (the CSA and the COO; the Partners; the manager).
3. Give each a client ID (e.g. `TG-CSA1`) and put it in the roster
   workbook's **Recipients** tab, **Karbon Client ID** column. Managers get a
   `Manager` row there just to carry their ID.
4. Confirm the Karbon API key may **create notes** (the rest of the app only
   reads).
5. Set `KARBON_NOTE_AUTHOR` (the Karbon user notes are posted as) and, for
   the trial, `KARBON_NOTES_SHADOW_CLIENT_ID`.

**Rollout:** a dry run previews the notes in `out/` (and still refuses any
client that isn't Hidden + Governance); `TG_KARBON_NOTES=shadow` posts every
note to the shadow client, assigned to `TG_SHADOW_TO`, while still checking the
real clients; then `live`.

**CSA follow-up:** CSAs comment on Tuesday's notes as they follow up. Friday
reads the latest two comments per escalated person into the Partner email and
note — nothing to configure.

**"refused" in the admin summary:** the named client isn't Hidden, isn't the
Governance type, or doesn't exist. Fix it in Karbon (or the Recipients tab)
and re-run the job; nothing was posted.

**"in_doubt":** the post to Karbon was cut off mid-flight (or an earlier
attempt never finished), so the note may or may not exist. It is not retried (notes can't be deleted through the API, so a
retry could leave a duplicate forever). Check the client's timeline in Karbon;
if it isn't there, delete its row from `karbon_notes` (status `posting`) and
re-run.

## Changing a rule

Thresholds are environment settings — change the secret and redeploy:
`MINIMAL_WEEK_HOURS`, `FULL_TIME_WEEK_HOURS`, `AD_HOC_WEEKLY_HOURS`,
`AD_HOC_RECURRING_WEEKS`, `AD_HOC_RECURRING_MIN_HOURS`, `NONBILLABLE_MIN_DESCRIPTION_CHARS`,
`INTERNAL_ONLY_ROLE_MARKER`, `ESCALATION_LOOKBACK_WEEKS`, `UTILIZATION_DROP_POINTS`,
`TG_KARBON_NOTES`, `KARBON_GOVERNANCE_CLIENT_TYPE`,
`HISTORY_RETENTION_DAYS`. Schedules (Tue/Fri 9:00, week-2 Monday 9:00) are
in `src/worker.ts`.
