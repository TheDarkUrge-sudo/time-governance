import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY } from '../policy';
import { entry, member, roster, userFor } from '../test-fixtures';
import { escalations } from './escalation';
import { runWeeklyChecks } from './weekly';

describe('Friday escalation', () => {
  const alvarez = member({ name: 'Jordan Alvarez' });
  const chen = member({ name: 'Riley Chen' });
  const brooks = member({ name: 'Taylor Brooks' });
  const users = [userFor(alvarez), userFor(chen), userFor(brooks)];

  // Friday's re-run: Alvarez still has nothing, Chen still minimal, Brooks caught up.
  const review = runWeeklyChecks({
    week: { start: '2026-09-21', end: '2026-09-27' },
    roster: roster([alvarez, chen, brooks]),
    users,
    entries: [
      entry({ userKey: users[1]!.id, date: '2026-09-21', minutes: 120 }),
      ...['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'].map((date) =>
        entry({ userKey: users[2]!.id, date, minutes: 480 }),
      ),
    ],
    internalClientKeys: new Set(),
    adHocWorkItemKeys: new Set(),
    clientNames: new Map(),
    priorAdHocStreak: () => 0,
    policy: DEFAULT_POLICY,
  });

  it('escalates only people flagged Tuesday who are still missing, worst habit first', () => {
    const rows = escalations({
      review,
      flaggedTuesday: new Set([alvarez.email, chen.email, brooks.email]),
      priorEscalations: (email) => (email === chen.email ? 2 : 0),
      lookbackWeeks: 4,
    });
    expect(rows.map((r) => [r.member.name, r.kind, r.weeksFlagged])).toEqual([
      ['Riley Chen', 'minimal_entry', 3],
      ['Jordan Alvarez', 'no_entry', 1],
    ]);
  });

  it('never escalates someone Tuesday did not flag', () => {
    const rows = escalations({
      review,
      flaggedTuesday: new Set([chen.email]),
      priorEscalations: () => 0,
      lookbackWeeks: 4,
    });
    expect(rows.map((r) => r.member.name)).toEqual(['Riley Chen']);
  });

  it('counts this year, including this week', () => {
    const rows = escalations({
      review,
      flaggedTuesday: new Set([alvarez.email]),
      priorEscalations: () => 0,
      priorThisYear: () => 5,
      lookbackWeeks: 4,
    });
    expect(rows[0]!.thisYear).toBe(6);
  });

  it('caps the count at the lookback window', () => {
    const rows = escalations({
      review,
      flaggedTuesday: new Set([alvarez.email]),
      priorEscalations: () => 9,
      lookbackWeeks: 4,
    });
    expect(rows[0]!.weeksFlagged).toBe(4);
  });
});
