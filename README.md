# HFA Time Governance

Automates the firm's Time Governance SOP (v1.0, June 2026) from Karbon's API:

| When (firm time)                     | What                                                                                                                             | To                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Mon 11:00                            | Time-entry reminder — **sent by Karbon itself**, not this app                                                                    | All staff                 |
| **Tue 9:00**                         | Weekly review of last Monday–Sunday: missing / minimal time + the four CSA checks                                                | Each CSA, their staff     |
| **Fri 9:00**                         | Re-check of the same week; anyone flagged Tuesday and still missing is escalated, with "weeks flagged" of the last 4             | Partners                  |
| **Mon 9:00, week 2** (1st Mon ≥ 8th) | Last month's billable / non-billable / PTO / sick vs. capacity, utilization % vs. target                                         | Each manager, their staff |
| After every run                      | What was sent, plus anything on the roster that needs fixing                                                                     | `TG_ADMIN_TO`             |
| Hourly, and when the worker starts   | **Missed-run check:** a scheduled run with no successful record an hour after its slot → one alert with the command to re-run it | `TG_ADMIN_TO`             |

It is a standalone worker — no web UI. The roster is a spreadsheet you upload
with one command; everything else runs on schedule. It runs anywhere that can
run Node 24 or a container, with Postgres: **Azure** ([docs/azure.md](docs/azure.md),
recommended — data stays in the firm's tenant) or **Replit** (`.replit`).
Admin commands run from a laptop in VS Code.

## Karbon governance notes (optional)

The emails are the alert; Karbon can hold the history, for people who live in
Karbon rather than their inbox. With `TG_KARBON_NOTES` on, each run also
posts notes to **Hidden clients of the Governance type** — one per CSA, one for
the Partners, one per manager (their client IDs go in the roster workbook's
Recipients tab):

- **Tuesday:** a note per flagged person on their CSA's governance client,
  assigned to the CSA, due Friday, listing the flags and entries.
- **Friday:** the CSA's comments on those notes are read back and printed in
  the Partner email ("CSA follow-up: spoke Tuesday, entering by Thursday"),
  and the escalation itself is posted to the Partners' governance client.
- **Monthly:** each manager's report is posted to their governance client.

A note only goes to a client that Karbon reports as **Hidden** and of type
**`KARBON_GOVERNANCE_CLIENT_TYPE`** — checked on every run (dry runs and
shadow included), so loosening a client's visibility in Karbon stops the notes
rather than exposing them. Karbon notes can't be deleted through the API, so
every post is claimed once and never blindly retried. Setup:
[docs/operations.md](docs/operations.md#karbon-governance-notes).

## The checks

| Check                                     | Flags when                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| No time logged                            | 0 hours for the week                                                                                                |
| Minimal entry                             | Worked hours under **20 h** (full-time), scaled for part-timers and reduced for firm holidays and PTO/sick logged   |
| 1. Internal client billability            | Any billable time on the internal HFA client (client ID **99999**)                                                  |
| 2. Internal-only roles                    | A role containing "(Internal Only)" used on a real client                                                           |
| 3. Non-billable time on client work       | Non-billable client time with a blank or very short (< 10 characters) description                                   |
| 4. Ad hoc work (internal client excluded) | Over **4 h** on one client's Ad Hoc work item in a week, or **at least 1 h** on the same client **3 weeks running** |

**Billable, non-billable, PTO and sick come from the roster workbook's Task
Types tab.** Karbon keeps billability on each task type, but its API gives
us only the task type's _name_ on each time entry, so the workbook maps every
name to a category. Any task type missing from the tab is listed in the admin
summary every week.

Utilization = billable ÷ capacity. Capacity = the person's Karbon
`CapacityMinutesPerWeek` × working days in the month ÷ 5 (firm holidays
excluded, PTO not). Without a Karbon capacity it falls back to the roster's
Expected Weekly Hours, then 40 h — and the report marks it with an asterisk.

The report also shows each person's change from the previous month ("vs.
Aug ▼ 8"), computed the same way from Karbon in the same run, so it works
from the first report. The summary names everyone under target with their
trend, and anyone who dropped 10+ points even if still at target. A month
with no time logged is "nothing to compare", not 0%.

Each indicator flag in the CSA email lists the entries behind it (date,
client, hours, task type, and the description where it matters), up to five,
so CSAs can follow up without opening Karbon.

**Every email is actionable.** Next to each flagged person is an **Email
{name}** button that opens a ready-to-edit draft in the reader's own mail
client — nothing is sent until they press Send:

- **CSA (Tuesday):** "I don't see your time for the week of Sep 21 in Karbon.
  Can you enter it by Thursday?", plus the specific entries to fix for any
  indicator flag.
- **Partners (Friday):** **Email {name}** — a reminder the first time; on a
  repeat, a request to talk, copying the manager — and **Email manager**.
- **Manager (monthly):** a note to each person under target or sharply down,
  with their numbers and an offer to talk.

With `KARBON_TIMESHEET_URL` set, each flagged person with time logged also
gets an **Open timesheet** button (CSAs are Karbon time administrators, so it
opens straight to that week), and the employee's draft and Tuesday's Karbon
note carry the same link. `pnpm tg karbon:check` prints a real one to click
before relying on it.

All thresholds are environment settings (see `.env.example`).

## Set up

The full ordered checklist — credentials, dry runs, test emails, shadow trial,
go-live, with the gate for each step — is **[docs/go-live.md](docs/go-live.md)**.
In short:

1. **Host and database** — Azure: follow [docs/azure.md](docs/azure.md).
   Replit: a project from this repo with the PostgreSQL module (sets
   `DATABASE_URL`), deployed as a Reserved VM → Background Worker.
2. **Secrets** — Karbon (`KARBON_API_KEY`, `KARBON_API_SECRET`), SendGrid
   (`SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`), `TG_SHADOW_TO` (the COO),
   `TG_ADMIN_TO`. Leave `TG_MODE` unset (= `shadow`).
3. **A laptop for admin commands** — VS Code, Node 24, `pnpm install`, and a
   `.env` pointing at the same database with `TG_MODE=off`
   ([details](docs/azure.md#running-admin-commands-from-vs-code)).
4. `pnpm tg karbon:check` — confirms the credentials can read users, time
   entries, capacity and the Ad Hoc work items.
5. **"Open timesheet" links (optional)** — open any timesheet in Karbon,
   copy the address, replace the last part (the timesheet key) with `{key}`
   and set it as `KARBON_TIMESHEET_URL`. Re-run `karbon:check` and open the
   link it prints.
6. The internal client is found by its client ID, **99999** by default
   (`KARBON_INTERNAL_CLIENT_IDS`). `karbon:check` shows what it resolved to.
7. **Fill in the roster workbook** — start from
   `templates/HFA_Staff_Roster_Template.xlsx`. `pnpm tg karbon:task-types`
   lists every task type used in the last 90 days, for the Task Types tab.
8. `pnpm tg roster:import roster.xlsx` (preview) → `… --apply` (save).
9. **Dry run against real data** — `pnpm tg run tuesday --dry-run`. Nothing
   is sent or saved; the emails are written to `out/`. Compare them with
   what the CSAs found by hand.
10. **Start the worker** (it applies migrations, then runs the schedules). It
    starts in shadow mode: every email goes to `TG_SHADOW_TO` with a banner
    naming the real recipients.
11. **Go live** per [docs/operations.md](docs/operations.md#rollout): two
    clean shadow Tuesdays, two Fridays, one month — then `TG_MODE=live`.

## Commands

```sh
pnpm tg status                        # mode, integrations, roster, recent runs
pnpm tg roster:import <file> [--apply]
pnpm tg run tuesday|friday|monthly    # run now (sends per TG_MODE; never sends twice)
    --week 2026-09-21 | --month 2026-09
    --dry-run [--roster file.xlsx] [--out dir]
pnpm tg karbon:check
pnpm tg karbon:task-types [--days 90]
pnpm tg karbon:clients <text>
pnpm tg history <name or email> [--all]   # one person's weekly record
pnpm tg history --export 2026 [--out f]   # a year's workbook for reviews

pnpm start          # production: migrate + worker (the Docker image does the same)
pnpm dev            # worker with reload
pnpm check          # format:check → typecheck → lint → test (CI order)
pnpm db:generate    # after changing src/db/schema.ts — commit the SQL
pnpm template       # rebuild templates/HFA_Staff_Roster_Template.xlsx
pnpm demo          # simulated 3-week run, fictional staff → out/demo (sends nothing)
```

## Data

- **Karbon** — reads users, capacity, individual time entries and work-item
  titles. Writes nothing unless governance notes are on; then it posts notes
  to Hidden Governance clients only.
- **SendGrid** — receives the email content (staff names, departments, hours,
  flags). Recipients are internal staff only. Open/click tracking is off.
- **Postgres** — the roster, each person's weekly flags and hours, ad hoc
  minutes per client, escalations, and send/run logs. History is kept about
  7 years (`HISTORY_RETENTION_DAYS`, 0 = forever) but never reported beyond
  4 weeks and the current year; older history is reachable only through
  `pnpm tg history`.
- **`out/`** — dry-run previews hold real staff data; the folder is
  gitignored and CI fails if anything in it is committed.

Background and the decisions behind each rule: [docs/decisions.md](docs/decisions.md).
