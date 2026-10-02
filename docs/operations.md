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

**Leavers:** set Status to Inactive rather than deleting the row — inactive
people are skipped, and the row keeps their history readable.

**New task type in Karbon:** the next Tuesday admin summary lists it under
"Task types not on the Task Types tab". Its time still counts toward the
person's weekly total, but not as billable, non-billable, PTO or sick until
it is added.

## When something goes wrong

**A scheduled run failed or the worker was down.** Run it by hand — it covers
the same period the schedule would have:

```sh
pnpm tg run tuesday                 # last Monday–Sunday
pnpm tg run friday
pnpm tg run monthly                 # last month
pnpm tg run tuesday --week 2026-09-21   # a specific week
```

Re-running is always safe: every email is claimed before it is sent, so
anything that already went out is skipped (`already_sent`).

**A send failed** (`failed` in the run output or admin summary): SendGrid
refused it, nothing was sent, and the claim was released — re-run the job
and only that email goes out.

**A send is `in_doubt`:** the request to SendGrid was cut off mid-flight, so
it may or may not have been delivered. It is NOT retried automatically
(that could double-send). Check SendGrid's activity feed; if it did not go
out, delete its row from `email_sends` (status `sending`) and re-run.

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

**"in_doubt":** the post to Karbon was cut off mid-flight, so the note may or
may not exist. It is not retried (notes can't be deleted through the API, so a
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
