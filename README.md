# HFA Time Governance

Automates the firm's Time Governance SOP (v1.0, June 2026) from Karbon's API:

| When (firm time)                     | What                                                                                                                 | To                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Mon 11:00                            | Time-entry reminder — **sent by Karbon itself**, not this app                                                        | All staff                 |
| **Tue 9:00**                         | Weekly review of last Monday–Sunday: missing / minimal time + the four CSA checks                                    | Each CSA, their staff     |
| **Fri 9:00**                         | Re-check of the same week; anyone flagged Tuesday and still missing is escalated, with "weeks flagged" of the last 4 | Partners                  |
| **Mon 9:00, week 2** (1st Mon ≥ 8th) | Last month's billable / non-billable / PTO / sick vs. capacity, utilization % vs. target                             | Each manager, their staff |
| After every run                      | What was sent, plus anything on the roster that needs fixing                                                         | `TG_ADMIN_TO`             |

It is a standalone worker — no web UI. The roster is a spreadsheet you upload
with one command; everything else runs on schedule.

## The checks

| Check                                     | Flags when                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| No time logged                            | 0 hours for the week                                                                                              |
| Minimal entry                             | Worked hours under **20 h** (full-time), scaled for part-timers and reduced for firm holidays and PTO/sick logged |
| 1. Internal client billability            | Any billable time on the internal HFA client (client ID **99999**)                                                |
| 2. Internal-only roles                    | A role containing "(Internal Only)" used on a real client                                                         |
| 3. Non-billable time on client work       | Non-billable client time with a blank or very short (< 10 characters) description                                 |
| 4. Ad hoc work (internal client excluded) | Over **4 h** on one client's Ad Hoc work item in a week, or the same client **3 weeks running**                   |

**Billable, non-billable, PTO and sick come from the roster workbook's Task
Types tab.** Karbon keeps billability on each task type, but its API gives
us only the task type's _name_ on each time entry, so the workbook maps every
name to a category. Any task type missing from the tab is listed in the admin
summary every week.

Utilization = billable ÷ capacity. Capacity = the person's Karbon
`CapacityMinutesPerWeek` × working days in the month ÷ 5 (firm holidays
excluded, PTO not). Without a Karbon capacity it falls back to the roster's
Expected Weekly Hours, then 40 h — and the report marks it with an asterisk.

All thresholds are environment settings (see `.env.example`).

## Set up

1. **Replit project** from this repo; add the PostgreSQL module (sets `DATABASE_URL`).
2. **Secrets** — Karbon (`KARBON_API_KEY`, `KARBON_API_SECRET`), SendGrid
   (`SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`), `TG_SHADOW_TO` (the COO),
   `TG_ADMIN_TO`. Leave `TG_MODE` unset (= `shadow`).
3. `pnpm install` then `pnpm db:migrate`.
4. `pnpm tg karbon:check` — confirms the credentials can read users, time
   entries, capacity and the Ad Hoc work items.
5. The internal client is found by its client ID, **99999** by default
   (`KARBON_INTERNAL_CLIENT_IDS`). `karbon:check` shows what it resolved to.
6. **Fill in the roster workbook** — start from
   `templates/HFA_Staff_Roster_Template.xlsx`. `pnpm tg karbon:task-types`
   lists every task type used in the last 90 days, for the Task Types tab.
7. `pnpm tg roster:import roster.xlsx` (preview) → `… --apply` (save).
8. **Dry run against real data** — `pnpm tg run tuesday --dry-run`. Nothing
   is sent or saved; the emails are written to `out/`. Compare them with
   what the CSAs found by hand.
9. **Deploy** as a Reserved VM → Background Worker (`pnpm start` migrates,
   then starts the schedules). It runs in shadow mode: every email goes to
   `TG_SHADOW_TO` with a banner naming the real recipients.
10. **Go live** per [docs/operations.md](docs/operations.md#rollout): two
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

pnpm start          # production: migrate + worker
pnpm dev            # worker with reload
pnpm check          # format:check → typecheck → lint → test (CI order)
pnpm db:generate    # after changing src/db/schema.ts — commit the SQL
pnpm template       # rebuild templates/HFA_Staff_Roster_Template.xlsx
pnpm tsx scripts/preview-emails.ts   # sample-data email previews → out/previews
```

## Data

- **Karbon** — read-only: users, capacity, individual time entries, work-item
  titles. Nothing is written back.
- **SendGrid** — receives the email content (staff names, departments, hours,
  flags). Recipients are internal staff only. Open/click tracking is off.
- **Postgres** — the roster, each person's weekly flags and hours, ad hoc
  minutes per client, escalations, and send/run logs. History older than
  `HISTORY_RETENTION_DAYS` (400 ≈ 13 months) is deleted after each Tuesday run.
- **`out/`** — dry-run previews hold real staff data; the folder is
  gitignored and CI fails if anything in it is committed.

Background and the decisions behind each rule: [docs/decisions.md](docs/decisions.md).
