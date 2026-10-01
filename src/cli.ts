/**
 * pnpm tg <command>
 *
 *   status                         mode, integrations, roster, recent runs
 *   roster:import <file.xlsx>      validate and preview a roster upload
 *       --apply                    …and save it
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
import { connect } from './db/client';
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
import { KarbonClient, karbonConfigured } from './karbon/client';
import { resolveInternalClients } from './karbon/internal-client';
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

async function main(): Promise<number> {
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
        'Usage: pnpm tg <status | roster:import <file> [--apply] | run <tuesday|friday|monthly> [--dry-run] | karbon:check | karbon:task-types | karbon:clients <text>>',
      );
      return command ? 1 : 0;
  }
}

async function status(): Promise<number> {
  say(
    `Mode:       ${env.TG_MODE}${env.TG_MODE === 'shadow' ? ` (all email → ${env.TG_SHADOW_TO ?? 'TG_SHADOW_TO NOT SET'})` : ''}`,
    `Karbon:     ${karbonConfigured() ? 'configured' : 'NOT configured'}`,
    `SendGrid:   ${emailConfigured() ? 'configured' : 'NOT configured'}`,
    `Admin to:   ${env.TG_ADMIN_TO.join(', ') || '(none)'}`,
    `Internal client: ID ${env.KARBON_INTERNAL_CLIENT_IDS.join(', ') || '(none)'}${env.KARBON_INTERNAL_CLIENT_KEYS.length ? ` + keys ${env.KARBON_INTERNAL_CLIENT_KEYS.join(', ')}` : ''}`,
    `Timezone:   ${env.FIRM_TIMEZONE} (today ${today})`,
  );
  if (!env.DATABASE_URL) {
    say('Database:   NOT configured');
    return 0;
  }
  const { db, close } = connect();
  try {
    const store = new Store(db);
    const counts = await store.countRoster();
    const last = await store.lastRosterImport();
    say(
      `Roster:     ${counts.members} people, ${counts.taskTypes} task types${last ? ` (uploaded ${last.createdAt.toISOString().slice(0, 10)} from ${last.fileName})` : ' — never uploaded'}`,
      '',
      'Recent runs:',
      ...(await store.recentRuns()).map(
        (r) =>
          `  ${r.startedAt.toISOString().slice(0, 16)}  ${r.job.padEnd(8)} ${r.period}  ${r.status}${r.error ? `  ${r.error}` : ''}`,
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

async function runJob(job: string | undefined): Promise<number> {
  if (job !== 'tuesday' && job !== 'friday' && job !== 'monthly') {
    say('Which job? pnpm tg run <tuesday|friday|monthly>');
    return 1;
  }
  const dryRun = values['dry-run'];
  let period: string;
  if (job === 'monthly') {
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
    const totals = escalationTotals(allEscalations, today, 4);
    const lines = timeline(
      weekly,
      allEscalations.filter((e) => !from || e.weekStart >= from),
    );
    say(
      `${person.name} <${person.email}>${person.department ? ` — ${person.department}` : ''}${person.managerName ? `, manager ${person.managerName}` : ''}${person.onRoster ? '' : '  (no longer on the roster)'}`,
      `Escalated to Partners: ${totals.recent} in the last 4 weeks · ${totals.thisYear} this year · ${totals.allTime} all time${totals.since ? ` (first: week of ${totals.since})` : ''}`,
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
