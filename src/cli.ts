/**
 * pnpm tg <command>
 *
 *   status                         mode, integrations, roster, recent runs
 *   roster:import <file.xlsx>      validate and preview a roster upload
 *       --apply                    …and save it
 *   run due                        run whatever is due today (laptop mode — see docs/laptop.md)
 *   run <tuesday|friday|monthly>   run a job now (sends per TG_MODE)
 *       --week YYYY-MM-DD          any date in the week to review (default: last week)
 *       --month YYYY-MM            the month to report (default: last month)
 *       --dry-run                  no sends, no database writes; previews to --out
 *       --roster file.xlsx         dry run only: read the roster from a workbook
 *       --out DIR                  preview folder (default: out/<job>-<period>)
 *   karbon:check                   verify the Karbon credentials can read what the jobs need
 *   karbon:task-types [--days N]   task types used in Karbon recently, and how the roster classifies them
 *   karbon:clients <text>          client keys whose name contains <text> (find the internal HFA client)
 *   history <name or email>        one person's weekly record (last 52 weeks; --all for everything)
 *   history --export YYYY          a workbook of that calendar year for reviews [--out file.xlsx]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  addDays,
  firmLocalDate,
  isIsoDate,
  mondayOf,
  previousMonth,
  previousWeek,
  weekOf,
} from './calendar';
import { categoryOf } from './checks/weekly';
import {
  connect,
  holdLocalDatabase,
  isLocalDatabase,
  localDatabaseDir,
  migrateDatabase,
} from './db/client';
import { Store } from './db/store';
import type { Roster } from './domain';
import { emailConfigured } from './email/sendgrid';
import { env } from './env';
import { escalationTotals, exportYear, findPeople, timeline } from './history/history';
import type { JobResult } from './jobs/context';
import { describeResults } from './jobs/deliver';
import { runFriday } from './jobs/friday';
import { runMonthly } from './jobs/monthly';
import { runTuesday } from './jobs/tuesday';
import { type ExpectedRun, findDueRuns, findMissedRuns } from './jobs/watchdog';
import { KarbonClient, karbonConfigured } from './karbon/client';
import { resolveInternalClients } from './karbon/internal-client';
import { timesheetUrl } from './karbon/links';
import { describeDiff, diffRoster } from './roster/diff';
import { parseRosterWorkbook } from './roster/workbook';
import { liveRuntime } from './runtime';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    apply: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    week: { type: 'string' },
    month: { type: 'string' },
    roster: { type: 'string' },
    out: { type: 'string' },
    days: { type: 'string', default: '90' },
    all: { type: 'boolean', default: false },
    export: { type: 'string' },
  },
});

const [command, arg] = positionals;
const today = firmLocalDate(new Date(), env.FIRM_TIMEZONE);
const say = (...lines: string[]) => console.log(lines.join('\n'));
/** "2026-09-22 09:00" in the firm's time zone (never toISOString(), which is UTC). */
const firmLocalDateTime = (d: Date) =>
  d.toLocaleString('sv-SE', { timeZone: env.FIRM_TIMEZONE, hour12: false }).slice(0, 16);

async function main(): Promise<number> {
  // Laptop mode: the local database is created and kept up to date here, so
  // there is no separate migrate step (only for the commands that use it).
  if (isLocalDatabase() && ['status', 'roster:import', 'run', 'history'].includes(command ?? '')) {
    await migrateDatabase();
  }
  switch (command) {
    case 'status':
      return status();
    case 'roster:import':
      return rosterImport(arg);
    case 'run':
      return runJob(arg);
    case 'karbon:check':
      return karbonCheck();
    case 'karbon:task-types':
      return taskTypes();
    case 'karbon:clients':
      return findClients(arg);
    case 'history':
      return history(arg);
    default:
      say(
        'Usage: pnpm tg <status | roster:import <file> [--apply] | run <due|tuesday|friday|monthly> [--dry-run] | karbon:check | karbon:task-types | karbon:clients <text> | history <name>>',
      );
      return command ? 1 : 0;
  }
}

async function missedRunLines(store: Store): Promise<string[]> {
  const missed = await findMissedRuns(store, new Date(), env.FIRM_TIMEZONE);
  if (missed.length === 0) return [];
  return [
    'MISSED RUNS (the worker emails TG_ADMIN_TO about these):',
    ...missed.map(
      (m) =>
        `  ${m.job.padEnd(8)} ${m.period}  scheduled ${m.scheduledOn} 9:00 — ${m.last ? (m.last.status === 'failed' ? `failed: ${m.last.error ?? '?'}` : 'never finished') : 'no record'}`,
    ),
    '',
  ];
}

async function status(): Promise<number> {
  say(
    `Mode:       ${env.TG_MODE}${env.TG_MODE === 'shadow' ? ` (all email → ${env.TG_SHADOW_TO ?? 'TG_SHADOW_TO NOT SET'})` : ''}`,
    `Karbon:     ${karbonConfigured() ? 'configured' : 'NOT configured'}`,
    `SendGrid:   ${emailConfigured() ? 'configured' : 'NOT configured'}`,
    `Admin to:   ${env.TG_ADMIN_TO.join(', ') || '(none)'}`,
    `Internal client: ID ${env.KARBON_INTERNAL_CLIENT_IDS.join(', ') || '(none)'}${env.KARBON_INTERNAL_CLIENT_KEYS.length ? ` + keys ${env.KARBON_INTERNAL_CLIENT_KEYS.join(', ')}` : ''}`,
    `Karbon notes: ${env.TG_KARBON_NOTES}${env.TG_KARBON_NOTES !== 'off' ? ` (as ${env.KARBON_NOTE_AUTHOR ?? 'KARBON_NOTE_AUTHOR NOT SET'}; Hidden "${env.KARBON_GOVERNANCE_CLIENT_TYPE || 'any type'}" clients only)` : ''}`,
    `Timezone:   ${env.FIRM_TIMEZONE} (today ${today})`,
  );
  if (!env.DATABASE_URL) {
    say('Database:   NOT configured');
    return 0;
  }
  say(
    `Database:   ${isLocalDatabase() ? `local folder ${localDatabaseDir(env.DATABASE_URL)} (laptop mode — run jobs with pnpm tg run due)` : 'PostgreSQL'}`,
  );
  const { db, close } = connect();
  try {
    const store = new Store(db);
    const counts = await store.countRoster();
    const last = await store.lastRosterImport();
    say(
      `Roster:     ${counts.members} people, ${counts.taskTypes} task types${last ? ` (uploaded ${firmLocalDate(last.createdAt, env.FIRM_TIMEZONE)} from ${last.fileName})` : ' — never uploaded'}`,
      '',
      ...(await missedRunLines(store)),
      'Recent runs:',
      ...(await store.recentRuns()).map(
        (r) =>
          `  ${firmLocalDateTime(r.startedAt)}  ${r.job.padEnd(8)} ${r.period}  ${r.status}${r.error ? `  ${r.error}` : ''}`,
      ),
    );
  } finally {
    await close();
  }
  return 0;
}

async function loadWorkbook(file: string | undefined) {
  if (!file) throw new Error('Give the workbook path: pnpm tg roster:import <file.xlsx>');
  const parsed = await parseRosterWorkbook(await readFile(file));
  if (parsed.warnings.length) say('Warnings:', ...parsed.warnings.map((w) => `  ! ${w}`), '');
  if (parsed.problems.length) {
    say(
      'The workbook was NOT imported. Fix these and try again:',
      ...parsed.problems.map((p) => `  ✗ ${p}`),
    );
    return null;
  }
  return parsed;
}

async function rosterImport(file: string | undefined): Promise<number> {
  const parsed = await loadWorkbook(file);
  if (!parsed) return 1;
  const r = parsed.roster;
  say(
    `Read ${r.members.length} people, ${r.recipients.length} recipients, ${r.taskTypes.size} task types, ${r.holidays.length} holidays.`,
  );
  if (karbonConfigured()) {
    const users = await new KarbonClient().listUsers();
    const known = new Set(users.map((u) => u.email?.toLowerCase()));
    const missing = r.members.filter((m) => m.active && !m.excluded && !known.has(m.email));
    say(
      missing.length === 0
        ? 'Every active roster email matches a Karbon user.'
        : `No Karbon user for: ${missing.map((m) => m.email).join(', ')}`,
    );
  }
  const { db, close } = connect();
  try {
    const store = new Store(db);
    const changes = describeDiff(diffRoster(await store.loadRoster(), r));
    say('', 'Changes:', ...changes.map((c) => `  ${c}`));
    if (!values.apply) {
      say('', 'Nothing saved. Re-run with --apply to save this roster.');
      return 0;
    }
    await store.replaceRoster(r, {
      fileName: path.basename(file!),
      changes,
      warnings: parsed.warnings,
    });
    say('', 'Roster saved.');
    return 0;
  } finally {
    await close();
  }
}

/**
 * With TG_MODE=off a real run would save results and record the run as done
 * while sending nothing — and the missed-run check would then stop alerting.
 */
function refusedInOffMode(): boolean {
  if (values['dry-run'] || env.TG_MODE !== 'off') return false;
  say(
    'TG_MODE is off here, so a real run would record results without sending anything.',
    'Use --dry-run to preview, or run it where the worker runs (the Replit Shell, or az containerapp exec on Azure) — or, on a laptop that is the host, set TG_MODE=shadow or live.',
  );
  return true;
}

/**
 * Laptop mode: run every job that is due today, in order. Safe to run every
 * morning (or from Task Scheduler): a job already run is skipped, and nothing
 * is ever sent twice.
 */
async function runDue(): Promise<number> {
  if (!env.DATABASE_URL || !isLocalDatabase()) {
    // With a hosted worker, the worker runs the schedule (and only alerts on a
    // missed run); `due` there would race it.
    say(
      '`run due` is for laptop mode (DATABASE_URL=pglite:…). With a hosted worker, re-run a job with pnpm tg run <tuesday|friday|monthly>.',
    );
    return 1;
  }
  if (refusedInOffMode()) return 1;
  // Hold the local database for the whole run, so a second `due` (Task
  // Scheduler and a manual one together) waits instead of repeating a job.
  const release = holdLocalDatabase(localDatabaseDir(env.DATABASE_URL));
  try {
    const { db, close } = connect();
    let due: ExpectedRun[];
    try {
      due = await findDueRuns(new Store(db), today);
    } finally {
      await close();
    }
    if (due.length === 0) {
      say(`Nothing due today (${today}).`);
      return 0;
    }
    let code = 0;
    const tuesdayRan = new Set<string>();
    for (const run of due) {
      // Friday escalates people CSAs followed up with since Tuesday; if that
      // week's Tuesday review only went out now, its escalation waits.
      if (run.job === 'friday' && tuesdayRan.has(run.period)) {
        say(
          '',
          `friday ${run.period}: waits — that week's Tuesday review only went out now. It runs next time (or: pnpm tg run friday --week ${run.period}).`,
        );
        continue;
      }
      say('', `── ${run.job} (scheduled ${run.scheduledOn}) ──`);
      if (run.job === 'tuesday') tuesdayRan.add(run.period);
      try {
        code = Math.max(code, await runJob(run.job, run.period));
      } catch (err) {
        // One job failing doesn't stop the rest; `tg status` shows it.
        say(`${run.job} failed: ${err instanceof Error ? err.message : String(err)}`);
        code = Math.max(code, 1);
      }
    }
    return code;
  } finally {
    release();
  }
}

async function runJob(job: string | undefined, periodOverride?: string): Promise<number> {
  if (job === 'due') return runDue();
  if (job !== 'tuesday' && job !== 'friday' && job !== 'monthly') {
    say('Which job? pnpm tg run <due|tuesday|friday|monthly>');
    return 1;
  }
  const dryRun = values['dry-run'];
  if (refusedInOffMode()) return 1;
  let period: string;
  if (periodOverride) {
    period = periodOverride;
  } else if (job === 'monthly') {
    if (values.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(values.month)) {
      throw new Error('--month must be YYYY-MM');
    }
    period = values.month ?? previousMonth(today);
  } else {
    if (values.week && !isIsoDate(values.week)) throw new Error('--week must be YYYY-MM-DD');
    period = values.week ? mondayOf(values.week) : previousWeek(today).start;
  }
  let roster: Roster | undefined;
  if (values.roster) {
    if (!dryRun)
      throw new Error('--roster is for dry runs only; import the roster to run for real.');
    const parsed = await loadWorkbook(values.roster);
    if (!parsed) return 1;
    roster = parsed.roster;
  }
  const outDir = dryRun ? path.resolve(values.out ?? path.join('out', `${job}-${period}`)) : null;
  const rt = await liveRuntime({ dryRun, outDir, roster });
  try {
    let result: JobResult;
    if (job === 'tuesday') result = await runTuesday(rt.deps, weekOf(period));
    else if (job === 'friday') result = await runFriday(rt.deps, weekOf(period));
    else result = await runMonthly(rt.deps, period);
    say(`${job} ${result.period}${dryRun ? ' (dry run)' : ` (mode ${env.TG_MODE})`}`, '');
    say(...describeResults(result.deliveries));
    for (const s of result.admin.filter((x) => x.lines.length > 0)) {
      say('', `${s.title}:`, ...s.lines.map((l) => `  - ${l}`));
    }
    if (outDir) say('', `Previews written to ${outDir}`);
    return result.deliveries.some((d) => d.outcome === 'failed' || d.outcome === 'in_doubt')
      ? 2
      : 0;
  } finally {
    await rt.close();
  }
}

async function karbonCheck(): Promise<number> {
  const karbon = new KarbonClient();
  const week = { start: addDays(today, -7), end: today };
  const [users, entries, adHoc] = await Promise.all([
    karbon.listUsers(),
    karbon.listTimeEntries(week),
    karbon.listAdHocWorkItems(env.KARBON_AD_HOC_TITLE),
  ]);
  const clients = new Set(entries.map((e) => e.clientKey).filter(Boolean));
  const internal = await resolveInternalClients(
    karbon,
    env.KARBON_INTERNAL_CLIENT_IDS,
    env.KARBON_INTERNAL_CLIENT_KEYS,
  );
  const seen = [...internal.keys].filter((k) => clients.has(k));
  say(
    `Users:                ${users.length}`,
    `Time entries, 7 days: ${entries.length} (${new Set(entries.map((e) => e.userKey)).size} people)`,
    `"${env.KARBON_AD_HOC_TITLE}" work items: ${adHoc.length} across ${new Set(adHoc.map((w) => w.clientKey)).size} clients`,
    `Internal client:      ${internal.resolved.join('; ') || 'NOT FOUND'}${internal.keys.size ? ` — time logged to it in the last 7 days: ${seen.length > 0 ? 'yes' : 'none'}` : ''}`,
    ...internal.notes.map((n) => `  ! ${n}`),
  );
  // "Open timesheet" links: show one real key, and the link built from it, so
  // the pattern can be confirmed by opening it before anyone relies on it.
  const sample = entries.find((e) => e.timesheetKey);
  if (!sample) {
    say('Timesheet keys:       none on the last 7 days of entries — links cannot be built');
  } else {
    const who = users.find((u) => u.id === sample.userKey)?.name ?? sample.userKey;
    const url = timesheetUrl(env.KARBON_TIMESHEET_URL ?? null, sample.timesheetKey);
    say(
      `Timesheet key:        ${sample.timesheetKey} (${who}, ${sample.date})`,
      url
        ? `Timesheet link:       ${url}\n                      open it — it should show that person's timesheet for that week`
        : '                      set KARBON_TIMESHEET_URL to add "Open timesheet" links',
    );
  }
  if (users.length > 0) {
    const capacity = await karbon.getUserCapacityMinutes(users[0]!.id);
    say(
      `Capacity readable:    yes (first user: ${capacity === null ? 'not set' : `${capacity / 60} h/week`})`,
    );
  }
  return 0;
}

async function taskTypes(): Promise<number> {
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a whole number of days');
  const karbon = new KarbonClient();
  const entries = await karbon.listTimeEntries({ start: addDays(today, -days), end: today });
  let roster: Roster | null = null;
  if (env.DATABASE_URL) {
    const { db, close } = connect();
    try {
      roster = await new Store(db).loadRoster();
    } finally {
      await close();
    }
  }
  const totals = new Map<string, number>();
  for (const e of entries) {
    const name = e.taskTypeName?.trim() || '(no task type)';
    totals.set(name, (totals.get(name) ?? 0) + e.minutes);
  }
  say(
    `Task types used in the last ${days} days (paste the missing ones into the Task Types tab):`,
    '',
  );
  for (const [name, minutes] of [...totals].sort((a, b) => b[1] - a[1])) {
    const category = roster ? (categoryOf(roster.taskTypes, name) ?? 'MISSING') : '?';
    say(`  ${name.padEnd(40)} ${(minutes / 60).toFixed(1).padStart(8)} h   ${category}`);
  }
  return 0;
}

async function history(query: string | undefined): Promise<number> {
  const { db, close } = connect();
  try {
    const store = new Store(db);
    const roster = await store.loadRoster();
    if (values.export) {
      if (!/^\d{4}$/.test(values.export))
        throw new Error('--export takes a year, e.g. --export 2026');
      const out = path.resolve(
        values.out ?? path.join('out', `time-governance-history-${values.export}.xlsx`),
      );
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, await exportYear(store, roster, values.export));
      say(
        `Wrote ${out}`,
        'It holds staff performance data — keep it out of shared folders and git.',
      );
      return 0;
    }
    if (!query) {
      say('Usage: pnpm tg history <name or email> [--all]   |   pnpm tg history --export 2026');
      return 1;
    }
    const matches = await findPeople(store, roster, query);
    if (matches.length === 0) {
      say(`Nobody on the roster or in the history matches "${query}".`);
      return 1;
    }
    if (matches.length > 1) {
      say(`"${query}" matches ${matches.length} people — be more specific:`);
      for (const p of matches)
        say(`  ${p.name} <${p.email}>${p.onRoster ? '' : '  (no longer on the roster)'}`);
      return 1;
    }
    const person = matches[0]!;
    const from = values.all ? undefined : addDays(today, -7 * 52);
    const weekly = await store.weeklyHistory({ email: person.email, from });
    const allEscalations = await store.escalationHistory({ email: person.email });
    const lookback = env.ESCALATION_LOOKBACK_WEEKS;
    const totals = escalationTotals(allEscalations, today, lookback);
    const lines = timeline(
      weekly,
      allEscalations.filter((e) => !from || e.weekStart >= from),
    );
    say(
      `${person.name} <${person.email}>${person.department ? ` — ${person.department}` : ''}${person.managerName ? `, manager ${person.managerName}` : ''}${person.onRoster ? '' : '  (no longer on the roster)'}`,
      `Escalated to Partners: ${totals.recent} in the last ${lookback} weeks · ${totals.thisYear} this year · ${totals.allTime} all time${totals.since ? ` (first: week of ${totals.since})` : ''}`,
      '',
    );
    if (lines.length === 0) {
      say(
        values.all ? 'No weekly history.' : 'No weekly history in the last 52 weeks (try --all).',
      );
      return 0;
    }
    say(`${'Week of'.padEnd(12)}${'Hours'.padStart(6)}  ${'Escalated'.padEnd(10)} Flags`);
    for (const l of lines) {
      const hrs = l.hoursLogged === null ? '' : l.hoursLogged.toFixed(1);
      say(
        `${l.weekStart.padEnd(12)}${hrs.padStart(6)}  ${(l.escalated ? 'yes' : '').padEnd(10)} ${l.flags.length ? l.details.join('; ') : '—'}`,
      );
    }
    if (!values.all) say('', 'Showing the last 52 weeks. Add --all for the full history.');
    return 0;
  } finally {
    await close();
  }
}

/** Client names come from each client's Ad Hoc work item (every client has one). */
async function findClients(text: string | undefined): Promise<number> {
  if (!text) {
    say('Usage: pnpm tg karbon:clients <part of the client name>');
    return 1;
  }
  const items = await new KarbonClient().listAdHocWorkItems(env.KARBON_AD_HOC_TITLE);
  const needle = text.toLowerCase();
  const seen = new Set<string>();
  for (const w of items) {
    if (seen.has(w.clientKey) || !(w.clientName ?? '').toLowerCase().includes(needle)) continue;
    seen.add(w.clientKey);
    say(`  ${w.clientKey.padEnd(16)} ${w.clientName}`);
  }
  if (seen.size === 0) say(`No client name contains "${text}".`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
    process.exit(1);
  });
