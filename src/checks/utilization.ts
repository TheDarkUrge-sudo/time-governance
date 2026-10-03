/**
 * The monthly manager report: billable, non-billable, PTO and sick hours per
 * person against capacity (decision 4, amended by 27: billable ÷ capacity,
 * capacity net of firm holidays AND of PTO/sick logged — utilization of the
 * time the person was actually available).
 *
 * Capacity = the person's weekly capacity × working days in the month ÷ 5,
 * less PTO and sick time logged on those working days (at most a day's
 * capacity per day). Leave logged on a firm holiday or a weekend isn't
 * subtracted again (the day isn't in capacity).
 * Weekly capacity comes from Karbon's per-user CapacityMinutesPerWeek; when
 * Karbon has none it falls back to the roster's Expected Weekly Hours, then
 * the full-time week. Someone hired mid-month is measured from their hire date.
 */
import { workingDays } from '../calendar';
import type { DateRange, KarbonUser, Policy, Roster, RosterMember } from '../domain';
import type { TimeEntry } from '../domain';
import {
  breakdown,
  checkableMembers,
  leaveOnWorkingDays,
  type MinuteBreakdown,
  usersByEmail,
} from './weekly';

export type CapacitySource = 'karbon' | 'roster' | 'default';

export interface UtilizationRow {
  member: RosterMember;
  minutes: MinuteBreakdown;
  capacityMinutes: number;
  capacitySource: CapacitySource;
  /** Billable ÷ capacity; null when capacity is zero. */
  utilization: number | null;
  target: number | null;
  underTarget: boolean;
  /** Last month's utilization, for the trend; null when there is no figure to compare. */
  previousUtilization?: number | null;
}

export interface UtilizationReport {
  month: DateRange;
  rows: UtilizationRow[];
  unmatched: RosterMember[];
}

export function runUtilization(input: {
  month: DateRange;
  roster: Roster;
  users: readonly KarbonUser[];
  entries: readonly TimeEntry[];
  /** Karbon user id → CapacityMinutesPerWeek (null/absent = not set in Karbon). */
  capacityMinutesPerWeek: ReadonlyMap<string, number | null>;
  policy: Policy;
}): UtilizationReport {
  const { month, roster, policy } = input;
  const byEmail = usersByEmail(input.users);
  const rows: UtilizationRow[] = [];
  const unmatched: RosterMember[] = [];

  for (const member of checkableMembers(roster, month)) {
    const user = byEmail.get(member.email);
    if (!user) {
      unmatched.push(member);
      continue;
    }
    const entries = input.entries.filter(
      (e) => e.userKey === user.id && e.date >= month.start && e.date <= month.end,
    );
    const minutes = breakdown(entries, roster.taskTypes);

    const karbonWeekly = input.capacityMinutesPerWeek.get(user.id) ?? null;
    let weekly: number;
    let capacitySource: CapacitySource;
    if (karbonWeekly !== null && karbonWeekly > 0) {
      weekly = karbonWeekly;
      capacitySource = 'karbon';
    } else if (member.expectedWeeklyHours !== null) {
      weekly = member.expectedWeeklyHours * 60;
      capacitySource = 'roster';
    } else {
      weekly = policy.fullTimeWeekHours * 60;
      capacitySource = 'default';
    }
    const from = member.hireDate && member.hireDate > month.start ? member.hireDate : month.start;
    const days = workingDays({ start: from, end: month.end }, roster.holidays);
    const working = new Set(days);
    const leave = leaveOnWorkingDays(entries, roster.taskTypes, working, weekly / 5);
    const capacityMinutes = Math.max(0, Math.round((weekly * days.length) / 5) - leave);
    const utilization = capacityMinutes > 0 ? minutes.billable / capacityMinutes : null;
    const target = member.utilizationTarget;

    rows.push({
      member,
      minutes,
      capacityMinutes,
      capacitySource,
      utilization,
      target,
      underTarget: target !== null && utilization !== null && utilization < target,
    });
  }

  rows.sort((a, b) => a.member.name.localeCompare(b.member.name));
  return { month, rows, unmatched: unmatched.sort((a, b) => a.name.localeCompare(b.name)) };
}

/**
 * Change in whole percentage points vs. last month, computed from the rounded
 * percentages so it always agrees with the two numbers the email shows.
 * Null when either month has no figure (new hire, no capacity).
 */
export function trendPoints(row: UtilizationRow): number | null {
  if (row.utilization === null || row.previousUtilization == null) return null;
  return Math.round(row.utilization * 100) - Math.round(row.previousUtilization * 100);
}

/**
 * Adds last month's utilization to each row (matched by email). A month with
 * no time logged at all is "nothing to compare", not 0% — otherwise someone's
 * first month in Karbon (e.g. a practice moving over from Axcess) reads as a
 * huge jump.
 */
export function attachTrend(
  current: UtilizationReport,
  previous: UtilizationReport,
): UtilizationReport {
  const prior = new Map(
    previous.rows.filter((r) => r.minutes.total > 0).map((r) => [r.member.email, r.utilization]),
  );
  return {
    ...current,
    rows: current.rows.map((r) => ({
      ...r,
      previousUtilization: prior.get(r.member.email) ?? null,
    })),
  };
}
