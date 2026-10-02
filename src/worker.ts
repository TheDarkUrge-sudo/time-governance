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
 */
import cron from 'node-cron';

import { firmLocalDate, isMonthlyReportDay, previousMonth, previousWeek } from './calendar';
import { env } from './env';
import type { JobResult } from './jobs/context';
import { runFriday } from './jobs/friday';
import { runMonthly } from './jobs/monthly';
import { runTuesday } from './jobs/tuesday';
import { karbonConfigured } from './karbon/client';
import { logger } from './logger';
import { liveRuntime, type Runtime } from './runtime';

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

const options = { timezone: env.FIRM_TIMEZONE };
const tasks = [
  cron.schedule('0 9 * * 2', () => void run('tuesday'), options),
  cron.schedule('0 9 * * 5', () => void run('friday'), options),
  cron.schedule('0 9 * * 1', () => void run('monthly'), options),
];

logger.info(
  { mode: env.TG_MODE, timezone: env.FIRM_TIMEZONE, karbon: karbonConfigured() },
  'time governance worker started — Tue 9:00, Fri 9:00, monthly on the week-2 Monday 9:00',
);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  for (const t of tasks) await t.stop();
  if (running) await running;
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
