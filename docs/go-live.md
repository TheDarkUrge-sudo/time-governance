# Go-live checklist

Everything between "the code is done" and "CSAs, Partners and Managers get
the emails" — in order, with how to check each step. Each step links to the
detailed procedure; this page is the order and the gates.

Who: **Owner** = the COO / program owner. **IT** = whoever holds the hosting
and Karbon/SendGrid admin rights. **CSA** = the CSA team.

## 0. Repository

| ✓   | Step                                                                                                                                                                                                                        | Who   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| ☐   | **Make the repository private** (GitHub → Settings → General → Danger Zone → Change visibility). It describes the firm's internal rules and staff process; no secrets or staff data are in it, but it should not be public. | Owner |
| ☐   | **Set `main` as the default branch** (Settings → Branches). Merge changes through pull requests from here on; CI runs on every one.                                                                                         | Owner |

## 1. See it before connecting anything (no credentials needed)

| ✓   | Step                                                                                                                                                                                                                                                                                                        | Who   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| ☐   | On a laptop: VS Code, Node 24, `corepack enable`, `pnpm install`, then **`pnpm demo`**. It runs the real Tuesday, Friday and monthly jobs over three weeks of fictional staff against a fake Karbon and writes every email, Karbon note, a history lookup and a year export to `out/demo`. Nothing is sent. | Owner |
| ☐   | Open the `.html` files in a browser. Click an **Email** button (opens a draft in your mail app — don't send it; the addresses are fictional) and an **Open timesheet** button (goes to a made-up Karbon address — it won't load).                                                                           | Owner |
| ☐   | `pnpm check` — format, typecheck, lint and tests, as CI runs them.                                                                                                                                                                                                                                          | IT    |

## 2. Accounts and credentials

| ✓   | Step                                                                                                                                                                                                                           | Who   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| ☐   | **Karbon API key + secret** (`KARBON_API_KEY`, `KARBON_API_SECRET`). Read access to users, time entries, work items and clients. If governance notes will be used: permission to create notes.                                 | IT    |
| ☐   | **SendGrid API key** (`SENDGRID_API_KEY`, Mail Send only) and a verified sender (`SENDGRID_FROM_EMAIL`) on a domain with SPF/DKIM set up in SendGrid, so the emails don't land in junk. Optional `TG_REPLY_TO` (e.g. the COO). | IT    |
| ☐   | `TG_SHADOW_TO` — who receives every email during the trial (the COO). `TG_ADMIN_TO` — who gets the after-run summary.                                                                                                          | Owner |
| ☐   | Leave `TG_MODE` unset (= `shadow`) and `TG_KARBON_NOTES` unset (= `off`).                                                                                                                                                      | IT    |

## 3. Host and database

| ✓   | Step                                                                                                                                                                                                                                                                                                   | Who |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- |
| ☐   | **Azure** (recommended): [docs/azure.md](azure.md) — one always-on Container App + Azure Database for PostgreSQL, secrets in the app. **Or Replit**: the PostgreSQL module + a Reserved VM → Background Worker deployment (`.replit`). Never an autoscale/sleeping host: the schedules would not fire. | IT  |
| ☐   | A laptop `.env` pointing at the same database with **`TG_MODE=off`**, so admin commands never send ([details](azure.md#running-admin-commands-from-vs-code)). Only the hosted worker sends.                                                                                                            | IT  |
| ☐   | Don't start the worker yet — steps 4–6 come first.                                                                                                                                                                                                                                                     | IT  |

## 4. Connect Karbon

| ✓   | Step                                                                                                                                                                                                                                                                                                                                           | Who   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| ☐   | `pnpm tg karbon:check`. Expect: a user count; time entries for the last 7 days; the number of **Ad Hoc** work items (≈ one per client); **Internal client** resolved from **99999**; capacity readable; a **Timesheet key**. Anything `NOT FOUND` or `none` is a setup problem to fix before going on.                                         | IT    |
| ☐   | **"Open timesheet" links (optional):** open any timesheet in Karbon, copy the address, replace the last part (the timesheet key) with `{key}` → `KARBON_TIMESHEET_URL=https://app2.karbonhq.com/<tenant key>/timesheet/{key}`. Re-run `karbon:check`, **click the link it prints** and confirm it opens that person's timesheet for that week. | Owner |

## 5. Roster and task types

| ✓   | Step                                                                                                                                                                                                                            | Who       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| ☐   | `pnpm tg karbon:task-types` — every task type used in the last 90 days. Classify **each** as Billable, Non-billable, PTO or Sick on the workbook's **Task Types** tab. (The API doesn't say which are billable; this tab does.) | Owner     |
| ☐   | Fill in `templates/HFA_Staff_Roster_Template.xlsx`: **Roster** (everyone who logs time; Partners/admin as Exclude = Yes), **Recipients** (each CSA slot's CSA, the Partners), **Holidays**. Delete the example rows.            | Owner/CSA |
| ☐   | `pnpm tg roster:import roster.xlsx` (preview: problems are listed with row numbers and block the import) → `… --apply`.                                                                                                         | Owner     |

## 6. Dry runs against real data (nothing sent, nothing saved)

| ✓   | Step                                                                                                                                                                                                                                                                                              | Who      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| ☐   | `pnpm tg run tuesday --dry-run --week 2026-09-21` for **three or four past weeks** the CSAs already reviewed by hand. Previews land in `out/`. **Gate:** the flags match what the CSAs found, or every difference is explained (a task type to reclassify, a roster fix, a threshold to discuss). | CSA      |
| ☐   | `pnpm tg run friday --dry-run --week …` for the same weeks, and `pnpm tg run monthly --dry-run --month 2026-09`. **Gate:** the monthly numbers reconcile with Karbon's own utilization report for that month.                                                                                     | Owner    |
| ☐   | In the previews, click a few **Email** buttons (read the draft; don't send) and **Open timesheet** buttons (each should open the right person's week).                                                                                                                                            | CSA      |
| ☐   | `out/` now holds real staff data: keep it on the laptop, delete it when done. It is gitignored, and CI fails if it is ever committed.                                                                                                                                                             | Everyone |

## 7. Test emails in a real inbox

Shadow mode sends every email to `TG_SHADOW_TO` only, subject `[Shadow]`,
with a banner naming who would have received it.

| ✓   | Step                                                                                                                                                                                                                                                                                                                                                                | Who   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| ☐   | From the laptop, with `TG_MODE=shadow` and `TG_SHADOW_TO` set to **your own** address for this one command: `pnpm tg run tuesday --week <a past week>`, then `friday` and `monthly` for past periods. Check the emails in Outlook desktop, Outlook web and a phone: layout, the Email buttons (Outlook may ask before opening a draft), the Open timesheet buttons. | Owner |
| ☐   | Each send is recorded once per week and mode, so re-running the same week in shadow is skipped (`already_sent`). Use another past week to send again. Past-week shadow sends don't block the real ones later.                                                                                                                                                       | —     |
| ☐   | Set the laptop back to `TG_MODE=off`.                                                                                                                                                                                                                                                                                                                               | Owner |

## 8. Firm sign-off and announcement

| ✓   | Step                                                                                                                                                                                                                                              | Who   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| ☐   | Sign off the rules as configured: minimal week 20 h (full-time), ad hoc 4 h / 3 weeks at 1 h+, the internal client 99999, the 10-character description test ([decisions](decisions.md)). Change thresholds through the environment, not the code. | Owner |
| ☐   | Announce the program to staff, CSAs, Managers and Partners — the launch deck (Gamma, HFA workspace) covers what changes and what to expect.                                                                                                       | Owner |

## 9. Shadow trial (the hosted worker)

| ✓   | Step                                                                                                                                                                                                      | Who   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| ☐   | **Start the worker** (it applies migrations, then runs the schedules: Tue 9:00, Fri 9:00, Monday of week 2 at 9:00, firm time). `pnpm tg status` shows each run.                                          | IT    |
| ☐   | **Gates** ([operations → Rollout](operations.md#rollout)): two shadow Tuesdays with no wrong flags · two shadow Fridays · one shadow monthly report that reconciles with Karbon. Read each admin summary. | Owner |

## 10. Go live

| ✓   | Step                                                                                                                                | Who   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ----- |
| ☐   | Set **`TG_MODE=live`** on the host and redeploy. Nothing already sent live is re-sent, and shadow history doesn't block live sends. | IT    |
| ☐   | First live Tuesday: confirm in the admin summary that each CSA's email shows `sent`, and ask one CSA to reply that it arrived.      | Owner |
| ☐   | Day to day — status, roster changes, failed or `in_doubt` sends, re-running a missed run: [docs/operations.md](operations.md).      | IT    |

## 11. Karbon governance notes (optional, after go-live)

| ✓   | Step                                                                                                                                                                                                                                                                                          | Who   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| ☐   | Karbon setup — a **Governance** client type; one **Hidden** client of that type per CSA, one for the Partners, one per manager who wants one, one for the trial; client IDs on the Recipients tab ([operations → Karbon governance notes](operations.md#karbon-governance-notes)).            | Owner |
| ☐   | `KARBON_NOTE_AUTHOR`, `KARBON_NOTES_SHADOW_CLIENT_ID`, then a dry run: previews land in `out/`, and any client that isn't Hidden + Governance is refused and named in the summary.                                                                                                            | IT    |
| ☐   | `TG_KARBON_NOTES=shadow` for a week: every note goes to the trial client. **Check in Karbon, on the web and on a phone,** that the notes read well and that the timesheet link is clickable — the API says notes accept HTML, but which tags Karbon keeps hasn't been confirmed. Then `live`. | Owner |
