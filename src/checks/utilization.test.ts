import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY } from '../policy';
import { entry, member, roster, userFor } from '../test-fixtures';
import { attachTrend, runUtilization, trendPoints } from './utilization';

// September 2026: 22 weekdays; Labor Day (Sep 7) leaves 21 working days.
const SEPT = { start: '2026-09-01', end: '2026-09-30' };
const LABOR_DAY = [{ date: '2026-09-07', name: 'Labor Day' }];

describe('monthly utilization', () => {
  const chen = member({ name: 'Riley Chen', utilizationTarget: 0.8 });
  const okafor = member({ name: 'Morgan Okafor', utilizationTarget: 0.8, expectedWeeklyHours: 30 });
  const fresh = member({ name: 'Fresh Hire', hireDate: '2026-09-16', utilizationTarget: null });
  const [u1, u2, u3] = [userFor(chen), userFor(okafor), userFor(fresh)];

  const report = runUtilization({
    month: SEPT,
    roster: roster([chen, okafor, fresh], { holidays: LABOR_DAY }),
    users: [u1, u2, u3],
    entries: [
      entry({ userKey: u1.id, date: '2026-09-02', minutes: 100 * 60 }),
      entry({ userKey: u1.id, date: '2026-09-03', minutes: 18 * 60, taskTypeName: 'Admin' }),
      entry({ userKey: u1.id, date: '2026-09-04', minutes: 8 * 60, taskTypeName: 'PTO' }),
      entry({ userKey: u1.id, date: '2026-10-01', minutes: 999 }), // next month
      entry({ userKey: u2.id, date: '2026-09-10', minutes: 110 * 60 }),
      entry({ userKey: u3.id, date: '2026-09-20', minutes: 60 * 60 }),
    ],
    capacityMinutesPerWeek: new Map([[u1.id, 2400]]),
    policy: DEFAULT_POLICY,
  });
  const row = (name: string) => report.rows.find((r) => r.member.name === name)!;

  it('uses Karbon capacity, net of firm holidays, gross of PTO', () => {
    const r = row('Riley Chen');
    expect(r.capacitySource).toBe('karbon');
    expect(r.capacityMinutes).toBe(2400 * (21 / 5)); // 168 h
    expect(r.minutes).toMatchObject({ billable: 6000, nonBillable: 1080, pto: 480 });
    expect(r.utilization).toBeCloseTo(100 / 168, 5);
    expect(r.underTarget).toBe(true);
  });

  it('falls back to the roster hours, then the full-time week', () => {
    const r = row('Morgan Okafor');
    expect(r.capacitySource).toBe('roster');
    expect(r.capacityMinutes).toBe(30 * 60 * (21 / 5)); // 126 h
    expect(r.underTarget).toBe(false); // 110 / 126 = 87%
  });

  it('measures a mid-month hire from their hire date, with no target', () => {
    const r = row('Fresh Hire');
    expect(r.capacitySource).toBe('default');
    expect(r.capacityMinutes).toBe(40 * 60 * (11 / 5)); // Sep 16–30 = 11 working days
    expect(r.target).toBeNull();
    expect(r.underTarget).toBe(false);
  });

  it('attaches last month by email, and rounds the change to match the shown percentages', () => {
    const august = runUtilization({
      month: { start: '2026-08-01', end: '2026-08-31' },
      roster: roster([chen, okafor], { holidays: LABOR_DAY }),
      users: [u1, u2],
      entries: [entry({ userKey: u1.id, date: '2026-08-05', minutes: 120 * 60 })],
      capacityMinutesPerWeek: new Map([[u1.id, 2400]]),
      policy: DEFAULT_POLICY,
    });
    const withTrend = attachTrend(report, august);
    const r = withTrend.rows.find((x) => x.member.name === 'Riley Chen')!;
    // August: 120 h of 21 working days × 8 h = 168 h → 71%; September 60%.
    expect(r.previousUtilization).toBeCloseTo(120 / 168, 5);
    expect(trendPoints(r)).toBe(60 - 71);
    // Okafor logged nothing in August: nothing to compare, not 0%.
    expect(
      withTrend.rows.find((x) => x.member.name === 'Morgan Okafor')!.previousUtilization,
    ).toBeNull();
    // Fresh Hire wasn't in August's report at all.
    expect(
      withTrend.rows.find((x) => x.member.name === 'Fresh Hire')!.previousUtilization,
    ).toBeNull();
    expect(trendPoints(withTrend.rows.find((x) => x.member.name === 'Fresh Hire')!)).toBeNull();
  });
});
