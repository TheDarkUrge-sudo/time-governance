/**
 * The long-kept history, for looking someone up and for the yearly export.
 * The emails never use any of this beyond 4 weeks and the current year — it is
 * here for reviews and for questions like "how long has this been going on?".
 */
import ExcelJS from 'exceljs';

import { addDays, mondayOf } from '../calendar';
import { FLAG_LABELS, type FlagKind, MISSING_KINDS } from '../checks/weekly';
import type { Store } from '../db/store';
import type { Roster } from '../domain';

export interface Person {
  email: string;
  name: string;
  department: string | null;
  managerName: string | null;
  onRoster: boolean;
}

type WeeklyRow = Awaited<ReturnType<Store['weeklyHistory']>>[number];
type EscalationRow = Awaited<ReturnType<Store['escalationHistory']>>[number];

export interface WeekLine {
  weekStart: string;
  /** Tuesday flags (labels), empty when clean. */
  flags: string[];
  details: string[];
  hoursLogged: number | null;
  escalated: boolean;
}

/** Roster members and past staff whose name or email contains `query`. */
export async function findPeople(store: Store, roster: Roster, query: string): Promise<Person[]> {
  const q = query.trim().toLowerCase();
  const byEmail = new Map<string, Person>();
  for (const p of await store.peopleWithHistory()) {
    byEmail.set(p.email, {
      email: p.email,
      name: p.name ?? p.email,
      department: p.department,
      managerName: p.managerName,
      onRoster: false,
    });
  }
  for (const m of roster.members) {
    byEmail.set(m.email, {
      email: m.email,
      name: m.name,
      department: m.department,
      managerName: m.managerName,
      onRoster: true,
    });
  }
  return [...byEmail.values()]
    .filter((p) => p.name.toLowerCase().includes(q) || p.email.includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** One line per reviewed week, newest first. */
export function timeline(weekly: WeeklyRow[], escalated: EscalationRow[]): WeekLine[] {
  const escalatedWeeks = new Set(escalated.map((e) => `${e.weekStart}|${e.email}`));
  const tuesdays = weekly.filter((w) => w.phase === 'tuesday');
  const fridayOnly = weekly.filter(
    (w) =>
      w.phase === 'friday' &&
      !tuesdays.some((t) => t.weekStart === w.weekStart && t.email === w.email),
  );
  return [...tuesdays, ...fridayOnly]
    .map((w) => ({
      weekStart: w.weekStart,
      flags: w.flags.map((f) => FLAG_LABELS[f.kind as FlagKind] ?? f.kind),
      details: w.flags.map((f) => f.detail),
      hoursLogged: typeof w.minutes.total === 'number' ? w.minutes.total / 60 : null,
      escalated: escalatedWeeks.has(`${w.weekStart}|${w.email}`),
    }))
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart));
}

/** Escalation totals for one person: last N weeks, this year, all time. */
export function escalationTotals(
  escalated: EscalationRow[],
  today: string,
  lookbackWeeks: number,
): { recent: number; thisYear: number; allTime: number; since: string | null } {
  // The last `lookbackWeeks` completed weeks — the same span as the Friday
  // email's "N of the last 4" (Friday escalates the week before).
  const thisWeek = mondayOf(today);
  const recentFrom = addDays(thisWeek, -7 * lookbackWeeks);
  const yearFrom = `${today.slice(0, 4)}-01-01`;
  return {
    recent: escalated.filter((e) => e.weekStart >= recentFrom && e.weekStart < thisWeek).length,
    thisYear: escalated.filter((e) => e.weekStart >= yearFrom).length,
    allTime: escalated.length,
    since: escalated[0]?.weekStart ?? null,
  };
}

/* ── Yearly export ──────────────────────────────────────────────────────── */

const INDICATORS: FlagKind[] = [
  'internal_client_billable',
  'internal_only_role',
  'nonbillable_unexplained',
  'ad_hoc_work',
];

/** A workbook of one calendar year: Summary, Weekly detail, Escalations. */
export async function exportYear(store: Store, roster: Roster, year: string): Promise<Buffer> {
  const range = { from: `${year}-01-01`, before: `${Number(year) + 1}-01-01` };
  const weekly = await store.weeklyHistory(range);
  const escalated = await store.escalationHistory(range);

  const people = new Map<string, { name: string; department: string; manager: string }>();
  for (const w of weekly) {
    people.set(w.email, {
      name: w.name ?? w.email,
      department: w.department ?? '',
      manager: w.managerName ?? '',
    });
  }
  for (const m of roster.members) {
    if (people.has(m.email)) {
      people.set(m.email, { name: m.name, department: m.department, manager: m.managerName ?? '' });
    }
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'HFA Time Governance';

  const summary = wb.addWorksheet('Summary');
  summary.columns = [
    { header: 'Employee', key: 'name', width: 24 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Department', key: 'department', width: 14 },
    { header: 'Manager', key: 'manager', width: 18 },
    { header: 'Weeks reviewed', key: 'reviewed', width: 15 },
    { header: 'Weeks missing / minimal', key: 'missing', width: 22 },
    { header: 'Escalated to Partners', key: 'escalated', width: 20 },
    ...INDICATORS.map((k) => ({ header: FLAG_LABELS[k], key: k, width: 18 })),
    { header: 'Last escalated (week of)', key: 'last', width: 22 },
  ];
  for (const [email, p] of [...people].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const tue = weekly.filter((w) => w.email === email && w.phase === 'tuesday');
    const esc = escalated.filter((e) => e.email === email);
    const count = (k: FlagKind) => tue.filter((w) => w.flags.some((f) => f.kind === k)).length;
    summary.addRow({
      name: p.name,
      email,
      department: p.department,
      manager: p.manager,
      reviewed: tue.length,
      missing: tue.filter((w) => w.flags.some((f) => MISSING_KINDS.has(f.kind as FlagKind))).length,
      escalated: esc.length,
      ...Object.fromEntries(INDICATORS.map((k) => [k, count(k)])),
      last: esc.at(-1)?.weekStart ?? '',
    });
  }

  const detail = wb.addWorksheet('Weekly detail');
  detail.columns = [
    { header: 'Week of', key: 'week', width: 12 },
    { header: 'Employee', key: 'name', width: 24 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Department', key: 'department', width: 14 },
    { header: 'Hours logged', key: 'hours', width: 13 },
    { header: 'Tuesday flags', key: 'flags', width: 40 },
    { header: 'Escalated', key: 'escalated', width: 10 },
    { header: 'Details', key: 'details', width: 80 },
  ];
  const escalatedKey = new Set(escalated.map((e) => `${e.weekStart}|${e.email}`));
  for (const w of weekly.filter((x) => x.phase === 'tuesday')) {
    detail.addRow({
      week: w.weekStart,
      name: w.name ?? people.get(w.email)?.name ?? w.email,
      email: w.email,
      department: w.department ?? '',
      hours: typeof w.minutes.total === 'number' ? Math.round(w.minutes.total / 6) / 10 : '',
      flags: w.flags.map((f) => FLAG_LABELS[f.kind as FlagKind] ?? f.kind).join('; '),
      escalated: escalatedKey.has(`${w.weekStart}|${w.email}`) ? 'Yes' : '',
      details: w.flags.map((f) => f.detail).join('; '),
    });
  }

  const esc = wb.addWorksheet('Escalations');
  esc.columns = [
    { header: 'Week of', key: 'week', width: 12 },
    { header: 'Employee', key: 'name', width: 24 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Reason', key: 'reason', width: 18 },
  ];
  for (const e of escalated) {
    esc.addRow({
      week: e.weekStart,
      name: people.get(e.email)?.name ?? e.email,
      email: e.email,
      reason: FLAG_LABELS[e.kind as FlagKind] ?? e.kind,
    });
  }

  for (const ws of [summary, detail, esc]) {
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
