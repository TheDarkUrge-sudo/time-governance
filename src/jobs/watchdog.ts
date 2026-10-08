/**
 * The missed-run check. The admin summary only arrives when a run happens, so
 * a run that never happens — the worker down or restarting at 9:00, a run that
 * failed before it started, one that died halfway — would otherwise go
 * unnoticed. The worker checks every hour and on every start: if a scheduled
 * run has no successful record an hour after its slot, TG_ADMIN_TO gets one
 * email saying which run, why (as far as the record shows), and the command
 * to run it now.
 *
 * It alerts; it never re-runs a job itself — a review landing at an odd hour,
 * or twice in a bad state, is worse than a person deciding.
 *
 * Limits: a worker that is down can't send anything, so a missed run is
 * reported when the worker comes back (the check runs on start) — and only
 * each job's most recent slot is checked, so an outage spanning two slots
 * reports the latest; the host's own monitoring covers the outage itself. A
 * job is only watched once it has run at least once, so a first deploy
 * doesn't alert about the runs before it existed. A run started in the last
 * two hours and still going counts as in progress, not missed.
 */
import {
  addDays,
  firmLocalTime,
  isMonthlyReportDay,
  previousMonth,
  previousWeek,
  weekday,
} from '../calendar';
import type { JobName, Store } from '../db/store';
import { renderMissedRun } from '../email/missed-run';
import { deliver, type DeliveryContext, type DeliveryResult } from './deliver';

/** How long after its 9:00 slot a run must have finished before it counts as missed. */
export const GRACE_MINUTES = 60;

/** A 'running' row younger than this is a run in progress (e.g. a re-run by hand), not a dead one. */
const IN_PROGRESS_MS = 2 * 60 * 60_000;

const SLOT_MINUTES = 9 * 60;

export interface ExpectedRun {
  job: JobName;
  /** The week (Monday) or month the run covers — job_runs.period. */
  period: string;
  /** The firm-local date of the scheduled 9:00 slot. */
  scheduledOn: string;
}

export interface MissedRun extends ExpectedRun {
  /** What the record shows: no run at all, a failure, or a run that never finished. */
  last: { status: 'running' | 'failed'; error: string | null } | null;
}

/** The latest date ≤ `date` (counting `date` only once the slot has passed) matching `match`. */
function lastSlot(
  local: { date: string; minutes: number },
  match: (date: string) => boolean,
): string {
  for (let back = 0; back < 60; back++) {
    const date = addDays(local.date, -back);
    if (back === 0 && local.minutes < SLOT_MINUTES) continue;
    if (match(date)) return date;
  }
  throw new Error('no schedule slot in the last 60 days');
}

/** The most recent slot of each job that should have finished by `now`, and the period it covers. */
export function expectedRuns(now: Date, timeZone: string): ExpectedRun[] {
  return slotsAt(firmLocalTime(new Date(now.getTime() - GRACE_MINUTES * 60_000), timeZone));
}

/** Each job's latest slot on or before `today` (today's counts all day) — for `tg run due`. */
export function latestSlots(today: string): ExpectedRun[] {
  return slotsAt({ date: today, minutes: 24 * 60 });
}

function slotsAt(local: { date: string; minutes: number }): ExpectedRun[] {
  const tuesday = lastSlot(local, (d) => weekday(d) === 2);
  const friday = lastSlot(local, (d) => weekday(d) === 5);
  const monthly = lastSlot(local, isMonthlyReportDay);
  return [
    { job: 'tuesday', period: previousWeek(tuesday).start, scheduledOn: tuesday },
    { job: 'friday', period: previousWeek(friday).start, scheduledOn: friday },
    { job: 'monthly', period: previousMonth(monthly), scheduledOn: monthly },
  ];
}

/** The expected runs with no successful record, for jobs that are already live. */
export async function findMissedRuns(
  store: Store,
  now: Date,
  timeZone: string,
): Promise<MissedRun[]> {
  const missed: MissedRun[] = [];
  for (const run of expectedRuns(now, timeZone)) {
    const last = await store.lastRun(run.job, run.period);
    if (last?.status === 'ok') continue;
    if (last?.status === 'running' && now.getTime() - last.startedAt.getTime() < IN_PROGRESS_MS) {
      continue;
    }
    // Not live yet: nothing has ever run for this job before this period.
    if (!last && !(await store.hadEarlierRun(run.job, run.period))) continue;
    missed.push({
      ...run,
      last: last ? { status: last.status, error: last.error } : null,
    });
  }
  return missed;
}

/**
 * Laptop mode (`tg run due`): each job's latest slot that has no successful
 * run yet. A job starts on its own day — its first run is when its slot is
 * today — so a first `due` doesn't send last month's report or an old week's
 * escalation; after that, a slot missed while the laptop was off is caught up.
 */
export async function findDueRuns(store: Store, today: string): Promise<ExpectedRun[]> {
  const due: ExpectedRun[] = [];
  for (const run of latestSlots(today)) {
    const last = await store.lastRun(run.job, run.period);
    if (last?.status === 'ok') continue;
    if (run.scheduledOn !== today && !last && !(await store.hadEarlierRun(run.job, run.period))) {
      continue;
    }
    due.push(run);
  }
  return due;
}

/** One email per missed run, claimed like every other send — so the hourly check alerts once. */
export async function alertMissedRuns(
  ctx: DeliveryContext,
  adminTo: string[],
  missed: MissedRun[],
): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [];
  for (const m of missed) {
    results.push(
      await deliver(ctx, {
        kind: 'missed_run',
        period: m.period,
        recipientKey: `admin:missed:${m.job}`,
        to: adminTo,
        content: renderMissedRun(m),
      }),
    );
  }
  return results;
}
