# Running from a laptop

Laptop mode runs everything from VS Code on a firm laptop: the same jobs and the
same emails as the hosted version. Nothing to install beyond Node, and no
server. You (or Windows Task Scheduler) run one command each workday morning;
it sends whatever is due.

Use it for the dry runs and the shadow trial, or for good if hosting isn't
available. The trade-offs are at the end.

## Set up (once)

1. **Node 24** (from nodejs.org or the firm's software center), then in a
   terminal: `corepack enable`.
2. Clone the repository and open it in VS Code. In the terminal:
   `pnpm install`.
3. Copy `.env.example` to `.env` and fill in:

   ```ini
   DATABASE_URL=pglite:./data      # the local database: a folder in the project
   KARBON_API_KEY=…
   KARBON_API_SECRET=…
   SENDGRID_API_KEY=…
   SENDGRID_FROM_EMAIL=…
   TG_MODE=shadow                  # every email to TG_SHADOW_TO until you go live
   TG_SHADOW_TO=you@hfacpas.com
   TG_ADMIN_TO=you@hfacpas.com
   KARBON_TIMESHEET_URL=…          # optional — see docs/go-live.md step 4
   ```

   The `data` folder is created on first use and migrations are applied
   automatically. It is gitignored; it holds staff history, so it stays on
   this laptop.

4. `pnpm tg karbon:check`, then import the roster:
   `pnpm tg roster:import roster.xlsx` → `… --apply`.
5. Dry runs on past weeks (`pnpm tg run tuesday --dry-run --week 2026-09-21`)
   exactly as in [go-live step 6](go-live.md).

## Each workday

```sh
pnpm tg run due
```

It runs whatever is due and nothing else:

| Day                                     | What runs                                  |
| --------------------------------------- | ------------------------------------------ |
| Tuesday                                 | The weekly review of last week → CSAs      |
| Friday                                  | The escalation of the same week → Partners |
| Monday of week 2 (1st Monday ≥ the 8th) | Last month's report → Managers             |
| Any other day                           | Nothing ("Nothing due today")              |

Running it twice, or every day, is safe: a job that already ran is skipped,
and no email is ever sent twice.

**If the laptop was off on the day**, the next `pnpm tg run due` catches up
that job's latest run. One exception: if a week's Tuesday review only goes out
on the Friday, that week's escalation waits for the next `due` (CSAs need time
to follow up first); `pnpm tg run friday --week <date>` sends it sooner.

**Starting out:** each job starts on its own day. A first `due` on a Thursday
sends nothing — no stale reports. The Tuesday review starts on the next
Tuesday, and so on.

`pnpm tg status` shows the runs so far and any that were missed.

## Optional: run it automatically (Windows Task Scheduler)

1. Task Scheduler → **Create Basic Task** → "Time governance".
2. Trigger: **Weekly**, Monday–Friday, **9:15 AM**.
3. Action: **Start a program**
   - Program: `cmd`
   - Arguments: `/c pnpm tg run due >> due.log 2>&1`
   - Start in: the project folder (e.g. `C:\Users\you\code\time-governance`)
4. Finish, then open the task's properties: **Run only when user is logged
   on**, and under Settings tick **Run task as soon as possible after a
   scheduled start is missed** (so a laptop that was asleep at 9:15 runs it
   when it wakes).

Check `due.log` in the project folder now and then; `pnpm tg status` gives
the same picture.

## Good to know

- **Its own database, never Clarity's.** Use `pglite:./data` here, not the
  connection string Clarity's scripts use. Setup refuses a database that
  another app already uses (its tables or migration history), so nothing is
  written to it — sharing one would mix staff data into the AR database and
  could make Clarity skip its own migrations.

- **One command at a time.** The local database allows one process; a second
  `tg` command while one is running says "in use by another tg command" —
  wait and retry. The hosted worker (`pnpm start`) refuses a local database.
- **`TG_MODE=off` refuses real runs** (they would record results and send
  nothing). Laptop mode uses `shadow`, then `live`.
- **Back up the `data` folder** now and then — copy it while no `tg` command
  is running. Don't put the live folder in OneDrive or another sync folder;
  syncing a database mid-write can corrupt it. Copy a backup there instead.
- **No missed-run email.** The hosted worker emails you when a run is
  missed; on a laptop, `due` simply catches up and `tg status` lists anything
  outstanding.

## Laptop or hosted?

|                  | Laptop                                 | Hosted (Replit / Azure)             |
| ---------------- | -------------------------------------- | ----------------------------------- |
| Runs on schedule | When you (or Task Scheduler) run `due` | Automatically, even when you're out |
| A missed day     | Caught up by the next `due`            | Emailed to `TG_ADMIN_TO`            |
| Database         | A folder on the laptop                 | Managed PostgreSQL                  |
| Staff history    | On one laptop — back it up             | In the hosted database              |
| Cost / approvals | None                                   | Hosting, and IT for Azure           |

The recommendation stays: laptop for the trial, hosted for go-live, so the
Tuesday review doesn't depend on one laptop being open. When you move,
point the hosted `DATABASE_URL` at PostgreSQL and import the roster there;
the weekly history starts again from the first hosted run (ask if you need
the laptop's history carried over — it can be exported).
