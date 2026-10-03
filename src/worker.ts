/**
 * The always-on worker: three schedules in the firm's timezone.
 *
 *   Tuesday 9:00   weekly review of last Monday–Sunday  → CSAs
 *   Friday  9:00   re-check of the same week            → Partners
 *   Monday  9:00   in week 2 only (first Monday on/after the 8th),
 *                  last month's utilization             → Managers
 *
 * Karbon sends its own Monday 11 AM reminder; nothing here duplicates it.
 * Each job is safe to re-run (sends are claimed once), so a missed or failed
 * run can be repeated by hand: `pnpm tg run tuesday`.
 *
 * Every hour, and on every start, the missed-run check emails TG_ADMIN_TO
 * about any scheduled run with no successful record (src/jobs/watchdog.ts).
 */
import cron from 'node-cron';

import { firmLocalDate, isMonthlyReportDay, previousMonth, previousWeek } from './calendar';
import { connect } from './db/client';
import { Store } from './db/store';
import { env } from './env';
import type { JobResult } from './jobs/context';
import { runFriday } from './jobs/friday';
import { runMonthly } from './jobs/monthly';
import { runTuesday } from './jobs/tuesday';
import { alertMissedRuns, findMissedRuns } from './jobs/watchdog';
import { karbonConfigured } from './karbon/client';
import { logger } from './logger';
import { alertDelivery, liveRuntime, type Runtime } from './runtime';

type Job = 'tuesday' | 'friday' | 'monthly';

let running: Promise<void> | null = null;

async function run(job: Job): Promise<void> {
  if (running) {
    logger.warn({ job }, 'a job is already running — skipping this fire');
    return;
  }
  const work = (async () => {
    const today = firmLocalDate(new Date(), env.FIRM_TIMEZONE);
    if (job === 'monthly' && !isMonthlyReportDay(today)) return;
    if (!karbonConfigured()) {
      logger.error({ job }, 'Karbon is not configured — job skipped');
      return;
    }
    // Everything inside the try: a fire that can't even set up (Karbon down,
    // a database blip, a config error) is logged, never an unhandled rejection
    // that takes the worker down with it.
    let rt: Runtime | null = null;
    try {
      rt = await liveRuntime({ dryRun: false, outDir: null });
      let result: JobResult;
      if (job === 'tuesday') result = await runTuesday(rt.deps, previousWeek(today));
      else if (job === 'friday') result = await runFriday(rt.deps, previousWeek(today));
      else result = await runMonthly(rt.deps, previousMonth(today));
      logger.info({ job, period: result.period, summary: result.summary }, 'job finished');
    } catch (err) {
      logger.error({ job, err }, 'job failed');
    } finally {
      await rt?.close().catch((err: unknown) => logger.error({ job, err }, 'closing failed'));
    }
  })();
  running = work;
  try {
    await work;
  } finally {
    running = null;
  }
}

let watching: Promise<void> | null = null;

/** The missed-run check, one at a time; shutdown waits for one that is sending. */
function watch(): Promise<void> {
  watching ??= checkMissedRuns().finally(() => (watching = null));
  return watching;
}

/** Never throws: a check that can't run is logged, not fatal. */
async function checkMissedRuns(): Promise<void> {
  if (running) return; // a run in progress isn't missed — the next check sees how it ended
  let conn: ReturnType<typeof connect> | null = null;
  try {
    conn = connect();
    const store = new Store(conn.db);
    const missed = await findMissedRuns(store, new Date(), env.FIRM_TIMEZONE);
    if (missed.length === 0) return;
    logger.warn({ missed }, 'scheduled run missed');
    const results = await alertMissedRuns(alertDelivery(store), env.TG_ADMIN_TO, missed);
    for (const r of results) {
      // Logged every hour while it lasts, so only a real failure is an error.
      if (r.outcome === 'failed' || r.outcome === 'no_recipient') {
        logger.error({ alert: r }, 'missed-run alert not sent');
      } else if (r.outcome === 'in_doubt') {
        logger.warn({ alert: r }, 'missed-run alert in doubt');
      }
    }
  } catch (err) {
    logger.error({ err }, 'missed-run check failed');
  } finally {
    await conn?.close().catch(() => undefined);
  }
}

const options = { timezone: env.FIRM_TIMEZONE };
const tasks = [
  cron.schedule('0 9 * * 2', () => void run('tuesday'), options),
  cron.schedule('0 9 * * 5', () => void run('friday'), options),
  cron.schedule('0 9 * * 1', () => void run('monthly'), options),
  cron.schedule('30 * * * *', () => void watch(), options),
];

logger.info(
  { mode: env.TG_MODE, timezone: env.FIRM_TIMEZONE, karbon: karbonConfigured() },
  'time governance worker started — Tue 9:00, Fri 9:00, monthly on the week-2 Monday 9:00, missed-run check hourly',
);
// A run missed while the worker was down is reported as soon as it is back.
void watch();

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  for (const t of tasks) await t.stop();
  if (running) await running;
  if (watching) await watching;
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
