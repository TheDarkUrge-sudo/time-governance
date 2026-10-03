import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY } from '../policy';
import { entry, member, roster, userFor } from '../test-fixtures';
import {
  mainTimesheet,
  minimalThresholdMinutes,
  runWeeklyChecks,
  type WeeklyInput,
} from './weekly';

const WEEK = { start: '2026-09-21', end: '2026-09-27' };
const MON = '2026-09-21';
const TUE = '2026-09-22';

function input(over: Partial<WeeklyInput>): WeeklyInput {
  return {
    week: WEEK,
    roster: roster([]),
    users: [],
    entries: [],
    internalClientKeys: new Set(['C-HFA']),
    adHocWorkItemKeys: new Set(['W-ADHOC-ACME', 'W-ADHOC-BETA']),
    clientNames: new Map([
      ['C-ACME', 'Acme Corp'],
      ['C-BETA', 'Beta LLC'],
    ]),
    priorAdHocStreak: () => 0,
    policy: DEFAULT_POLICY,
    ...over,
  };
}

/** 40 h of clean billable time for one user. */
function fullWeek(userKey: string) {
  return ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'].map((date) =>
    entry({ userKey, date, minutes: 480 }),
  );
}

describe('minimal threshold', () => {
  it('is 20 h for a full-time week', () => {
    expect(
      minimalThresholdMinutes({
        expectedWeeklyHours: 40,
        holidayCount: 0,
        leaveMinutes: 0,
        policy: DEFAULT_POLICY,
      }),
    ).toBe(1200);
  });

  it('scales to part-time and shrinks with holidays and leave', () => {
    const t = (expected: number, holidays: number, leave: number) =>
      minimalThresholdMinutes({
        expectedWeeklyHours: expected,
        holidayCount: holidays,
        leaveMinutes: leave,
        policy: DEFAULT_POLICY,
      });
    expect(t(20, 0, 0)).toBe(600); // half-time → 10 h
    expect(t(40, 1, 0)).toBe(960); // one holiday → 16 h
    expect(t(40, 0, 16 * 60)).toBe(720); // two days PTO → 12 h
    expect(t(40, 5, 0)).toBeNull(); // whole week off
    expect(t(40, 0, 40 * 60)).toBeNull(); // whole week PTO
  });
});

describe('weekly checks', () => {
  const alvarez = member({ name: 'Jordan Alvarez' });
  const chen = member({ name: 'Riley Chen', department: 'Tax' });
  const u1 = userFor(alvarez);
  const u2 = userFor(chen);

  it('flags no entry and minimal entry, and leaves a full week clean', () => {
    const okafor = member({ name: 'Morgan Okafor' });
    const u3 = userFor(okafor);
    const review = runWeeklyChecks(
      input({
        roster: roster([alvarez, chen, okafor]),
        users: [u1, u2, u3],
        entries: [entry({ userKey: u2.id, date: MON, minutes: 210 }), ...fullWeek(u3.id)],
      }),
    );
    const flags = Object.fromEntries(review.people.map((p) => [p.member.name, p.flags]));
    expect(flags['Jordan Alvarez']).toEqual([
      { kind: 'no_entry', minutes: 0, detail: 'No time logged for the week' },
    ]);
    expect(flags['Riley Chen']).toEqual([
      {
        kind: 'minimal_entry',
        minutes: 210,
        detail: '3.5 h logged; expected at least 20.0 h',
      },
    ]);
    expect(flags['Morgan Okafor']).toEqual([]);
  });

  it('keeps the timesheet holding most of the week, for the "Open timesheet" link', () => {
    const review = runWeeklyChecks(
      input({
        roster: roster([alvarez, chen]),
        users: [u1, u2],
        entries: [
          entry({ userKey: u2.id, date: MON, minutes: 240, timesheetKey: 'TSmain' }),
          entry({ userKey: u2.id, date: MON, minutes: 60, timesheetKey: 'TSother' }),
          entry({ userKey: u2.id, date: MON, minutes: 120, timesheetKey: 'TSmain' }),
        ],
      }),
    );
    const key = Object.fromEntries(review.people.map((p) => [p.member.name, p.timesheetKey]));
    expect(key['Riley Chen']).toBe('TSmain');
    expect(key['Jordan Alvarez']).toBeNull(); // no time, no key
    expect(mainTimesheet([entry({ userKey: 'u', date: MON, timesheetKey: null })])).toBeNull();
  });

  it('does not count PTO as worked time, but lowers the bar for it', () => {
    const entries = [
      entry({
        userKey: u1.id,
        date: MON,
        minutes: 24 * 60,
        taskTypeName: 'PTO',
        clientKey: 'C-HFA',
      }),
      entry({ userKey: u1.id, date: TUE, minutes: 7 * 60 }),
    ];
    const review = runWeeklyChecks(input({ roster: roster([alvarez]), users: [u1], entries }));
    // 24 h PTO → 16 h available → threshold 8 h; 7 h worked is under it.
    expect(review.people[0]!.minimalThresholdMinutes).toBe(480);
    expect(review.people[0]!.flags.map((f) => f.kind)).toEqual(['minimal_entry']);
  });

  it('PTO logged on a firm holiday does not lower the bar a second time', () => {
    const entries = [
      // "PTO - Holiday" style entry on the firm holiday itself.
      entry({
        userKey: u1.id,
        date: MON,
        minutes: 8 * 60,
        taskTypeName: 'PTO',
        clientKey: 'C-HFA',
      }),
      entry({ userKey: u1.id, date: TUE, minutes: 13 * 60 }),
    ];
    const review = runWeeklyChecks(
      input({
        roster: roster([alvarez], { holidays: [{ date: MON, name: 'Firm holiday' }] }),
        users: [u1],
        entries,
      }),
    );
    // One holiday → 32 h available → 16 h line (not 12 h from counting the day twice).
    expect(review.people[0]!.minimalThresholdMinutes).toBe(16 * 60);
    expect(review.people[0]!.flags.map((f) => f.kind)).toEqual(['minimal_entry']);
  });

  it('skips the missing check for someone hired mid-week, and skips not-yet-started staff entirely', () => {
    const newHire = member({ name: 'New Hire', hireDate: '2026-09-24' });
    const future = member({ name: 'Future Hire', hireDate: '2026-10-05' });
    const review = runWeeklyChecks(
      input({
        roster: roster([newHire, future]),
        users: [userFor(newHire), userFor(future)],
      }),
    );
    expect(review.people.map((p) => p.member.name)).toEqual(['New Hire']);
    expect(review.people[0]!.flags).toEqual([]);
  });

  it('skips inactive and excluded members, and reports roster emails Karbon does not know', () => {
    const partner = member({ name: 'Pat Partner', excluded: true });
    const gone = member({ name: 'Gone Person', active: false });
    const ghost = member({ name: 'Ghost Person' });
    const review = runWeeklyChecks(
      input({ roster: roster([partner, gone, ghost]), users: [userFor(partner)] }),
    );
    expect(review.people).toEqual([]);
    expect(review.unmatched.map((m) => m.name)).toEqual(['Ghost Person']);
  });

  it('check 1: billable time on the internal HFA client', () => {
    const entries = [
      ...fullWeek(u1.id),
      entry({
        userKey: u1.id,
        date: MON,
        minutes: 120,
        clientKey: 'C-HFA',
        taskTypeName: 'Audit Fieldwork',
      }),
      entry({ userKey: u1.id, date: MON, minutes: 60, clientKey: 'C-HFA', taskTypeName: 'Admin' }),
    ];
    const review = runWeeklyChecks(input({ roster: roster([alvarez]), users: [u1], entries }));
    expect(review.people[0]!.flags).toEqual([
      {
        kind: 'internal_client_billable',
        minutes: 120,
        detail: '2.0 h billable on the internal HFA client',
        entries: [
          {
            date: MON,
            client: 'Internal HFA client',
            minutes: 120,
            taskType: 'Audit Fieldwork',
            role: 'Staff',
            description: 'Testing controls for year-end',
          },
        ],
      },
    ]);
  });

  it('check 2: an (Internal Only) role on a real client, case-insensitively', () => {
    const entries = [
      ...fullWeek(u1.id),
      entry({ userKey: u1.id, date: TUE, minutes: 90, roleName: 'Admin (internal only)' }),
      entry({
        userKey: u1.id,
        date: TUE,
        minutes: 30,
        roleName: 'Admin (Internal Only)',
        clientKey: 'C-HFA',
        taskTypeName: 'Admin',
      }),
    ];
    const review = runWeeklyChecks(input({ roster: roster([alvarez]), users: [u1], entries }));
    expect(review.people[0]!.flags).toEqual([
      {
        kind: 'internal_only_role',
        minutes: 90,
        detail: '(Internal Only) role on Acme Corp',
        entries: [expect.objectContaining({ client: 'Acme Corp', role: 'Admin (internal only)' })],
      },
    ]);
  });

  it('check 3: non-billable client time with a blank or very short description', () => {
    const entries = [
      ...fullWeek(u1.id),
      entry({ userKey: u1.id, date: TUE, minutes: 60, taskTypeName: 'Admin', description: '' }),
      entry({ userKey: u1.id, date: TUE, minutes: 30, taskTypeName: 'Admin', description: 'call' }),
      entry({
        userKey: u1.id,
        date: TUE,
        minutes: 45,
        taskTypeName: 'Admin',
        description: 'Re-did workpapers after reviewer notes',
      }),
    ];
    const review = runWeeklyChecks(input({ roster: roster([alvarez]), users: [u1], entries }));
    expect(review.people[0]!.flags).toEqual([
      {
        kind: 'nonbillable_unexplained',
        minutes: 90,
        detail: '2 non-billable entries with no clear description',
        entries: [
          expect.objectContaining({ minutes: 60, description: null }),
          expect.objectContaining({ minutes: 30, description: 'call' }),
        ],
      },
    ]);
  });

  it('check 4: ad hoc work over 4 h, or 3 weeks running, one flag per client', () => {
    const entries = [
      ...fullWeek(u1.id),
      entry({ userKey: u1.id, date: MON, minutes: 300, workItemKey: 'W-ADHOC-ACME' }),
      entry({
        userKey: u1.id,
        date: TUE,
        minutes: 60,
        workItemKey: 'W-ADHOC-BETA',
        clientKey: 'C-BETA',
      }),
    ];
    const streaks: Record<string, number> = { 'C-BETA': 2, 'C-ACME': 0 };
    const review = runWeeklyChecks(
      input({
        roster: roster([alvarez]),
        users: [u1],
        entries,
        priorAdHocStreak: (_u, client) => streaks[client] ?? 0,
      }),
    );
    expect(review.people[0]!.flags).toEqual([
      {
        kind: 'ad_hoc_work',
        minutes: 300,
        detail: "5.0 h on Acme Corp's Ad Hoc work item",
        entries: [expect.objectContaining({ date: MON, client: 'Acme Corp', minutes: 300 })],
      },
      {
        kind: 'ad_hoc_work',
        minutes: 60,
        detail: "1.0 h on Beta LLC's Ad Hoc work item, 3 weeks running",
        entries: [expect.objectContaining({ date: TUE, client: 'Beta LLC', minutes: 60 })],
      },
    ]);
    expect(review.adHocUsage).toEqual([
      { userKey: u1.id, email: alvarez.email, clientKey: 'C-ACME', minutes: 300 },
      { userKey: u1.id, email: alvarez.email, clientKey: 'C-BETA', minutes: 60 },
    ]);
  });

  it('a week under the 1-hour minimum does not count toward an ad hoc streak', () => {
    const entries = [
      ...fullWeek(u1.id),
      entry({
        userKey: u1.id,
        date: TUE,
        minutes: 45,
        workItemKey: 'W-ADHOC-BETA',
        clientKey: 'C-BETA',
      }),
    ];
    const review = runWeeklyChecks(
      input({ roster: roster([alvarez]), users: [u1], entries, priorAdHocStreak: () => 5 }),
    );
    expect(review.people[0]!.flags).toEqual([]);
    // Still recorded, so the history is complete; the store applies the minimum when reading it back.
    expect(review.adHocUsage).toHaveLength(1);
  });

  it('ignores ad hoc time on the internal client', () => {
    const entries = [
      ...fullWeek(u1.id),
      entry({
        userKey: u1.id,
        date: MON,
        minutes: 600,
        workItemKey: 'W-ADHOC-HFA',
        clientKey: 'C-HFA',
        taskTypeName: 'Admin',
      }),
    ];
    const review = runWeeklyChecks(
      input({
        roster: roster([alvarez]),
        users: [u1],
        entries,
        adHocWorkItemKeys: new Set(['W-ADHOC-HFA']),
      }),
    );
    expect(review.people[0]!.flags).toEqual([]);
    expect(review.adHocUsage).toEqual([]);
  });

  it('ad hoc time under the line and not recurring is recorded but not flagged', () => {
    const entries = [
      ...fullWeek(u1.id),
      entry({ userKey: u1.id, date: MON, minutes: 240, workItemKey: 'W-ADHOC-ACME' }),
    ];
    const review = runWeeklyChecks(input({ roster: roster([alvarez]), users: [u1], entries }));
    expect(review.people[0]!.flags).toEqual([]);
    expect(review.adHocUsage).toHaveLength(1);
  });

  it('lists task types missing from the Task Types tab, and ignores other weeks', () => {
    const entries = [
      ...fullWeek(u1.id),
      entry({ userKey: u1.id, date: MON, minutes: 60, taskTypeName: 'Brand New Code' }),
      entry({ userKey: u1.id, date: TUE, minutes: 30, taskTypeName: 'Brand New Code' }),
      entry({ userKey: u1.id, date: TUE, minutes: 15, taskTypeName: null }),
      entry({ userKey: u1.id, date: '2026-09-28', minutes: 999, taskTypeName: 'Next Week Code' }),
    ];
    const review = runWeeklyChecks(input({ roster: roster([alvarez]), users: [u1], entries }));
    expect(review.unclassifiedTaskTypes).toEqual([
      { name: 'Brand New Code', minutes: 90, entries: 2 },
      { name: '(no task type)', minutes: 15, entries: 1 },
    ]);
    expect(review.people[0]!.minutes.total).toBe(2400 + 105);
  });

  it('matches roster emails to Karbon users case-insensitively', () => {
    const review = runWeeklyChecks(
      input({
        roster: roster([alvarez]),
        users: [{ id: 'k1', name: 'J', email: alvarez.email.toUpperCase() }],
        entries: fullWeek('k1'),
      }),
    );
    expect(review.unmatched).toEqual([]);
    expect(review.people[0]!.karbonUserId).toBe('k1');
  });

  it('a firm holiday lowers the bar', () => {
    const entries = ['2026-11-23', '2026-11-24'].map((date) =>
      entry({ userKey: u1.id, date, minutes: 480 }),
    );
    const review = runWeeklyChecks(
      input({
        week: { start: '2026-11-23', end: '2026-11-29' },
        roster: roster([alvarez], { holidays: [{ date: '2026-11-26', name: 'Thanksgiving' }] }),
        users: [u1],
        entries,
      }),
    );
    expect(review.people[0]!.minimalThresholdMinutes).toBe(960);
    expect(review.people[0]!.flags).toEqual([]);
  });
});
