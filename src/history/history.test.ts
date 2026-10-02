import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PersonWeek } from '../checks/weekly';
import type { Db } from '../db/client';
import { Store } from '../db/store';
import { testDb } from '../db/test-db';
import { member, roster } from '../test-fixtures';
import { escalationTotals, exportYear, findPeople, timeline } from './history';

const chen = member({ name: 'Riley Chen', department: 'Tax' });
const leaver = member({ name: 'Former Person', department: 'Audit' });

const week = (m: typeof chen, flags: PersonWeek['flags'], total = 600): PersonWeek => ({
  member: m,
  karbonUserId: `k-${m.email}`,
  minutes: { total, billable: total, nonBillable: 0, pto: 0, sick: 0, unclassified: 0 },
  minimalThresholdMinutes: 1200,
  timesheetKey: null,
  flags,
});
const minimal = {
  kind: 'minimal_entry' as const,
  minutes: 600,
  detail: '10.0 h logged; expected at least 20.0 h',
};

describe('history', () => {
  let db: Db;
  let close: () => Promise<void>;
  let store: Store;

  beforeEach(async () => {
    ({ db, close } = await testDb());
    store = new Store(db);
    // The leaver has history but is no longer on the roster.
    await store.saveWeeklyResults('2025-11-03', 'tuesday', [
      week(leaver, [minimal]),
      week(chen, []),
    ]);
    await store.saveEscalations('2025-11-03', [{ email: leaver.email, kind: 'minimal_entry' }]);
    for (const w of ['2026-08-31', '2026-09-14', '2026-09-21']) {
      await store.saveWeeklyResults(w, 'tuesday', [week(chen, [minimal])]);
      await store.saveWeeklyResults(w, 'friday', [week(chen, [minimal])]);
      await store.saveEscalations(w, [{ email: chen.email, kind: 'minimal_entry' }]);
    }
    await store.saveEscalations('2025-12-01', [{ email: chen.email, kind: 'no_entry' }]);
  });
  afterEach(async () => close());

  it('finds roster members and past staff, with their last known details', async () => {
    const r = roster([chen]);
    expect((await findPeople(store, r, 'chen')).map((p) => [p.name, p.onRoster])).toEqual([
      ['Riley Chen', true],
    ]);
    const former = await findPeople(store, r, 'former');
    expect(former).toEqual([
      {
        email: leaver.email,
        name: 'Former Person',
        department: 'Audit',
        managerName: 'Dana Ferris',
        onRoster: false,
      },
    ]);
    expect(await findPeople(store, r, 'hfacpas')).toHaveLength(2);
  });

  it('builds a newest-first timeline and escalation totals', async () => {
    const weekly = await store.weeklyHistory({ email: chen.email });
    const esc = await store.escalationHistory({ email: chen.email });
    const lines = timeline(weekly, esc);
    expect(lines.map((l) => [l.weekStart, l.escalated, l.hoursLogged])).toEqual([
      ['2026-09-21', true, 10],
      ['2026-09-14', true, 10],
      ['2026-08-31', true, 10],
      ['2025-11-03', false, 10],
    ]);
    expect(lines[0]!.flags).toEqual(['Minimal entry']);
    expect(escalationTotals(esc, '2026-10-01', 4)).toEqual({
      recent: 3, // the last 4 full weeks as of Oct 1: Aug 31, Sep 7, Sep 14, Sep 21
      thisYear: 3,
      allTime: 4,
      since: '2025-12-01',
    });
  });

  it('exports a calendar year as a workbook', async () => {
    const buf = await exportYear(store, roster([chen]), '2026');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Weekly detail', 'Escalations']);
    const summary = wb.getWorksheet('Summary')!;
    expect(summary.rowCount).toBe(2); // header + Riley Chen (the leaver's history is 2025)
    const row = summary.getRow(2);
    expect(row.getCell(1).value).toBe('Riley Chen');
    expect(row.getCell(5).value).toBe(3); // weeks reviewed
    expect(row.getCell(6).value).toBe(3); // weeks missing / minimal
    expect(row.getCell(7).value).toBe(3); // escalated in 2026
    expect(row.getCell(12).value).toBe('2026-09-21');
    expect(wb.getWorksheet('Weekly detail')!.rowCount).toBe(4);
    expect(wb.getWorksheet('Escalations')!.rowCount).toBe(4);
  });
});
