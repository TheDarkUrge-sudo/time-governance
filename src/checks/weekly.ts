/**
 * The Tuesday review: the SOP's missing/minimal check plus its four
 * misrouted-time checks, over one Monday–Sunday week. Pure — Karbon data, the
 * roster and the ad hoc history come in; flags come out.
 *
 * Billability, PTO and sick come from the roster workbook's Task Types tab,
 * because Karbon's API hands us each entry's task type NAME but not the
 * billable flag Karbon keeps on the task type itself.
 */
import { weekdayHolidays } from '../calendar';
import type {
  DateRange,
  KarbonUser,
  Policy,
  Roster,
  RosterMember,
  TaskCategory,
  TimeEntry,
} from '../domain';
import { hours } from '../format';

export type FlagKind =
  | 'no_entry'
  | 'minimal_entry'
  | 'internal_client_billable'
  | 'internal_only_role'
  | 'nonbillable_unexplained'
  | 'ad_hoc_work';

export const FLAG_LABELS: Record<FlagKind, string> = {
  no_entry: 'No entry',
  minimal_entry: 'Minimal entry',
  internal_client_billable: 'Internal Client Billability',
  internal_only_role: 'Internal-Only Roles',
  nonbillable_unexplained: 'Non-Billable Time on Client Work',
  ad_hoc_work: 'Ad Hoc Work',
};

/** The "missing time" kinds — the ones Friday re-checks and escalates. */
export const MISSING_KINDS: ReadonlySet<FlagKind> = new Set(['no_entry', 'minimal_entry']);

/** One time entry behind a flag — what the CSA needs to follow up without opening Karbon. */
export interface FlagEntry {
  date: string;
  client: string;
  minutes: number;
  taskType: string | null;
  role: string | null;
  description: string | null;
}

export interface Flag {
  kind: FlagKind;
  minutes: number;
  detail: string;
  /** The entries behind an indicator flag (none for no entry / minimal entry). */
  entries?: FlagEntry[];
}

export interface MinuteBreakdown {
  total: number;
  billable: number;
  nonBillable: number;
  pto: number;
  sick: number;
  /** Task types missing from the Task Types tab. */
  unclassified: number;
}

export interface PersonWeek {
  member: RosterMember;
  karbonUserId: string;
  minutes: MinuteBreakdown;
  /** Null when the missing/minimal check did not apply (hired mid-week, a full week off). */
  minimalThresholdMinutes: number | null;
  flags: Flag[];
  /**
   * The Karbon timesheet holding most of this week's time — the one to open.
   * Null with no time logged (the API only exposes the key through entries).
   */
  timesheetKey: string | null;
}

export interface AdHocUsage {
  userKey: string;
  email: string;
  clientKey: string;
  minutes: number;
}

export interface UnclassifiedTaskType {
  name: string;
  minutes: number;
  entries: number;
}

export interface WeeklyReview {
  week: DateRange;
  people: PersonWeek[];
  /** Active roster members with no Karbon user at their email — nothing could be checked. */
  unmatched: RosterMember[];
  unclassifiedTaskTypes: UnclassifiedTaskType[];
  /** Every (person, client) with ad hoc time this week — stored so next week can spot a streak. */
  adHocUsage: AdHocUsage[];
}

export interface WeeklyInput {
  week: DateRange;
  roster: Roster;
  users: readonly KarbonUser[];
  entries: readonly TimeEntry[];
  internalClientKeys: ReadonlySet<string>;
  adHocWorkItemKeys: ReadonlySet<string>;
  clientNames: ReadonlyMap<string, string>;
  /** Consecutive weeks immediately before this one in which the user logged ad hoc time to the client. */
  priorAdHocStreak: (userKey: string, clientKey: string) => number;
  policy: Policy;
}

export function categoryOf(
  taskTypes: ReadonlyMap<string, TaskCategory>,
  name: string | null,
): TaskCategory | null {
  if (!name) return null;
  return taskTypes.get(name.trim().toLowerCase()) ?? null;
}

/** Roster members the checks apply to this period. */
export function checkableMembers(roster: Roster, range: DateRange): RosterMember[] {
  return roster.members.filter(
    (m) => m.active && !m.excluded && !(m.hireDate && m.hireDate > range.end),
  );
}

/** Karbon users by lower-cased email (first one wins on a duplicate). */
export function usersByEmail(users: readonly KarbonUser[]): Map<string, KarbonUser> {
  const map = new Map<string, KarbonUser>();
  for (const u of users) {
    const email = u.email?.trim().toLowerCase();
    if (email && !map.has(email)) map.set(email, u);
  }
  return map;
}

export function breakdown(
  entries: readonly TimeEntry[],
  taskTypes: ReadonlyMap<string, TaskCategory>,
): MinuteBreakdown {
  const out: MinuteBreakdown = {
    total: 0,
    billable: 0,
    nonBillable: 0,
    pto: 0,
    sick: 0,
    unclassified: 0,
  };
  for (const e of entries) {
    out.total += e.minutes;
    const cat = categoryOf(taskTypes, e.taskTypeName);
    if (cat === 'billable') out.billable += e.minutes;
    else if (cat === 'non_billable') out.nonBillable += e.minutes;
    else if (cat === 'pto') out.pto += e.minutes;
    else if (cat === 'sick') out.sick += e.minutes;
    else out.unclassified += e.minutes;
  }
  return out;
}

/**
 * The minimal-week line in minutes (decision 1): MINIMAL_WEEK_HOURS for a
 * full-time week, scaled to the person's expected hours, then reduced in
 * proportion to the firm holidays and PTO/sick they had that week.
 * Null = the week was entirely off, so there is nothing to check.
 */
export function minimalThresholdMinutes(opts: {
  expectedWeeklyHours: number;
  holidayCount: number;
  leaveMinutes: number;
  policy: Policy;
}): number | null {
  const expected = opts.expectedWeeklyHours * 60;
  if (expected <= 0) return null;
  const holidayMinutes = (expected / 5) * opts.holidayCount;
  const available = expected - holidayMinutes - opts.leaveMinutes;
  if (available <= 0) return null;
  const base =
    opts.policy.minimalWeekHours * 60 * (expected / (opts.policy.fullTimeWeekHours * 60));
  return Math.round(base * (available / expected));
}

export function runWeeklyChecks(input: WeeklyInput): WeeklyReview {
  const { week, roster, policy } = input;
  const byEmail = usersByEmail(input.users);
  const weekHolidays = weekdayHolidays(week, roster.holidays);
  const holidayCount = weekHolidays.length;
  const holidayDates = new Set(weekHolidays.map((h) => h.date));
  const inWeek = input.entries.filter((e) => e.date >= week.start && e.date <= week.end);
  const entriesByUser = new Map<string, TimeEntry[]>();
  for (const e of inWeek) {
    const list = entriesByUser.get(e.userKey);
    if (list) list.push(e);
    else entriesByUser.set(e.userKey, [e]);
  }
  const clientName = (key: string) => input.clientNames.get(key) ?? 'a client';
  const internalName = 'Internal HFA client';
  const detailOf = (list: readonly TimeEntry[]): FlagEntry[] =>
    [...list]
      .sort((a, b) => a.date.localeCompare(b.date) || b.minutes - a.minutes)
      .map((e) => ({
        date: e.date,
        client:
          e.clientKey === null
            ? '—'
            : isInternal(e.clientKey)
              ? internalName
              : clientName(e.clientKey),
        minutes: e.minutes,
        taskType: e.taskTypeName,
        role: e.roleName,
        description: e.description?.trim() || null,
      }));
  const isInternal = (key: string | null) => key !== null && input.internalClientKeys.has(key);
  const marker = policy.internalOnlyRoleMarker.toLowerCase();

  const people: PersonWeek[] = [];
  const unmatched: RosterMember[] = [];
  const adHocUsage: AdHocUsage[] = [];
  const unclassified = new Map<string, UnclassifiedTaskType>();

  for (const member of checkableMembers(roster, week)) {
    const user = byEmail.get(member.email);
    if (!user) {
      unmatched.push(member);
      continue;
    }
    const entries = entriesByUser.get(user.id) ?? [];
    const minutes = breakdown(entries, roster.taskTypes);
    const flags: Flag[] = [];

    // Missing / minimal. Someone hired mid-week is not held to a full week.
    const hiredMidWeek = member.hireDate !== null && member.hireDate > week.start;
    const threshold = hiredMidWeek
      ? null
      : minimalThresholdMinutes({
          expectedWeeklyHours: member.expectedWeeklyHours ?? policy.fullTimeWeekHours,
          holidayCount,
          // A firm holiday already lowers the line; PTO logged on it (a "PTO -
          // Holiday" code) must not lower it a second time.
          leaveMinutes: entries
            .filter((e) => !holidayDates.has(e.date))
            .filter((e) => {
              const c = categoryOf(roster.taskTypes, e.taskTypeName);
              return c === 'pto' || c === 'sick';
            })
            .reduce((acc, e) => acc + e.minutes, 0),
          policy,
        });
    if (threshold !== null) {
      const worked = minutes.total - minutes.pto - minutes.sick;
      if (minutes.total === 0) {
        flags.push({ kind: 'no_entry', minutes: 0, detail: 'No time logged for the week' });
      } else if (worked < threshold) {
        flags.push({
          kind: 'minimal_entry',
          minutes: worked,
          detail: `${hours(worked)} h logged; expected at least ${hours(threshold)} h`,
        });
      }
    }

    // 1. Billable time on the internal HFA client.
    const internalBillable = entries.filter(
      (e) => isInternal(e.clientKey) && categoryOf(roster.taskTypes, e.taskTypeName) === 'billable',
    );
    if (internalBillable.length > 0) {
      const m = sum(internalBillable);
      flags.push({
        kind: 'internal_client_billable',
        minutes: m,
        detail: `${hours(m)} h billable on the internal HFA client`,
        entries: detailOf(internalBillable),
      });
    }

    // 2. An "(Internal Only)" role used on a real client.
    const internalRole = entries.filter(
      (e) =>
        e.clientKey !== null &&
        !isInternal(e.clientKey) &&
        (e.roleName ?? '').toLowerCase().includes(marker),
    );
    if (internalRole.length > 0) {
      const m = sum(internalRole);
      const clients = distinct(internalRole.map((e) => clientName(e.clientKey!)));
      flags.push({
        kind: 'internal_only_role',
        minutes: m,
        detail: `${policy.internalOnlyRoleMarker} role on ${listOf(clients)}`,
        entries: detailOf(internalRole),
      });
    }

    // 3. Non-billable client time with no real explanation.
    const unexplained = entries.filter(
      (e) =>
        e.clientKey !== null &&
        !isInternal(e.clientKey) &&
        categoryOf(roster.taskTypes, e.taskTypeName) === 'non_billable' &&
        (e.description ?? '').trim().length < policy.nonBillableMinDescriptionChars,
    );
    if (unexplained.length > 0) {
      const m = sum(unexplained);
      const n = unexplained.length;
      flags.push({
        kind: 'nonbillable_unexplained',
        minutes: m,
        detail: `${n} non-billable ${n === 1 ? 'entry' : 'entries'} with no clear description`,
        entries: detailOf(unexplained),
      });
    }

    // 4. Ad hoc work that is sizeable or keeps coming back — one flag per client.
    const adHocByClient = new Map<string, number>();
    const adHocEntries = new Map<string, TimeEntry[]>();
    for (const e of entries) {
      if (e.workItemKey === null || !input.adHocWorkItemKeys.has(e.workItemKey)) continue;
      // The internal client's time is administrative, not client work to reassign.
      if (e.clientKey === null || isInternal(e.clientKey)) continue;
      adHocByClient.set(e.clientKey, (adHocByClient.get(e.clientKey) ?? 0) + e.minutes);
      adHocEntries.set(e.clientKey, [...(adHocEntries.get(e.clientKey) ?? []), e]);
    }
    for (const [clientKey, m] of [...adHocByClient].sort((a, b) => b[1] - a[1])) {
      adHocUsage.push({ userKey: user.id, email: member.email, clientKey, minutes: m });
      // A week counts toward a streak only with at least the minimum on it,
      // so 15 minutes a week on the same client is not a pattern.
      const countsThisWeek = m >= policy.adHocRecurringMinHours * 60;
      const weeksRunning = input.priorAdHocStreak(user.id, clientKey) + 1;
      const sizeable = m > policy.adHocWeeklyHours * 60;
      const recurring = countsThisWeek && weeksRunning >= policy.adHocRecurringWeeks;
      if (!sizeable && !recurring) continue;
      const parts = [`${hours(m)} h on ${clientName(clientKey)}'s Ad Hoc work item`];
      if (recurring) parts.push(`${weeksRunning} weeks running`);
      flags.push({
        kind: 'ad_hoc_work',
        minutes: m,
        detail: parts.join(', '),
        entries: detailOf(adHocEntries.get(clientKey) ?? []),
      });
    }

    for (const e of entries) {
      if (categoryOf(roster.taskTypes, e.taskTypeName) !== null) continue;
      const name = e.taskTypeName?.trim() || '(no task type)';
      const row = unclassified.get(name) ?? { name, minutes: 0, entries: 0 };
      row.minutes += e.minutes;
      row.entries += 1;
      unclassified.set(name, row);
    }

    people.push({
      member,
      karbonUserId: user.id,
      minutes,
      minimalThresholdMinutes: threshold,
      flags,
      timesheetKey: mainTimesheet(entries),
    });
  }

  people.sort((a, b) => a.member.name.localeCompare(b.member.name));
  return {
    week,
    people,
    unmatched: unmatched.sort((a, b) => a.name.localeCompare(b.name)),
    unclassifiedTaskTypes: [...unclassified.values()].sort((a, b) => b.minutes - a.minutes),
    adHocUsage,
  };
}

/**
 * The timesheet with the most minutes in the week. A firm with weekly
 * Monday–Sunday timesheets has exactly one; a different period start can split
 * the week across two, and the larger one is the one worth opening.
 */
export function mainTimesheet(entries: readonly TimeEntry[]): string | null {
  const byKey = new Map<string, number>();
  for (const e of entries) {
    if (e.timesheetKey) byKey.set(e.timesheetKey, (byKey.get(e.timesheetKey) ?? 0) + e.minutes);
  }
  let best: string | null = null;
  let bestMinutes = -1;
  for (const [key, m] of byKey) {
    if (m > bestMinutes) [best, bestMinutes] = [key, m];
  }
  return best;
}

function sum(entries: readonly TimeEntry[]): number {
  return entries.reduce((acc, e) => acc + e.minutes, 0);
}

function distinct(items: string[]): string[] {
  return [...new Set(items)];
}

function listOf(items: string[]): string {
  if (items.length <= 2) return items.join(' and ');
  return `${items.slice(0, 2).join(', ')} and ${items.length - 2} more`;
}
