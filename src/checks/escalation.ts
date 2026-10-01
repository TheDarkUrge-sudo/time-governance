/**
 * The Friday escalation: of the people the Tuesday review flagged for missing
 * or minimal time, who is STILL missing on Friday — plus how many of the last
 * few weeks each of them has been escalated, so Partners can tell a first
 * occurrence (a quick reminder) from a habit (a conversation).
 */
import type { RosterMember } from '../domain';
import { type FlagKind, MISSING_KINDS, type WeeklyReview } from './weekly';

export interface EscalationRow {
  member: RosterMember;
  kind: FlagKind;
  minutes: number;
  /** This week plus the prior escalated weeks inside the lookback. */
  weeksFlagged: number;
  lookbackWeeks: number;
}

export function escalations(opts: {
  /** Friday's fresh re-run of the week. */
  review: WeeklyReview;
  /** Emails flagged on Tuesday for missing/minimal time. Only they can be escalated. */
  flaggedTuesday: ReadonlySet<string>;
  /** Weeks this person was escalated in the (lookback − 1) weeks before this one. */
  priorEscalations: (email: string) => number;
  lookbackWeeks: number;
}): EscalationRow[] {
  const rows: EscalationRow[] = [];
  for (const p of opts.review.people) {
    if (!opts.flaggedTuesday.has(p.member.email)) continue;
    const missing = p.flags.find((f) => MISSING_KINDS.has(f.kind));
    if (!missing) continue;
    rows.push({
      member: p.member,
      kind: missing.kind,
      minutes: missing.minutes,
      weeksFlagged: Math.min(opts.lookbackWeeks, opts.priorEscalations(p.member.email) + 1),
      lookbackWeeks: opts.lookbackWeeks,
    });
  }
  return rows.sort(
    (a, b) => b.weeksFlagged - a.weeksFlagged || a.member.name.localeCompare(b.member.name),
  );
}
