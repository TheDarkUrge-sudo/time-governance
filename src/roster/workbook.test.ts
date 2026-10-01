import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import { member, roster } from '../test-fixtures';
import { describeDiff, diffRoster } from './diff';
import { buildTemplateWorkbook } from './template';
import { parseRosterWorkbook } from './workbook';

/** The template with its example rows replaced by `fill`. */
async function workbook(fill: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildTemplateWorkbook()) as unknown as ArrayBuffer);
  const rosterTab = wb.getWorksheet('Roster')!;
  for (let r = 3; r <= 5; r++) rosterTab.getRow(r).values = [];
  fill(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function rows(wb: ExcelJS.Workbook, tab: string, values: unknown[][]) {
  const ws = wb.getWorksheet(tab)!;
  values.forEach((v, i) => {
    ws.getRow(3 + i).values = v as ExcelJS.CellValue[];
  });
}

const GOOD = (wb: ExcelJS.Workbook) => {
  rows(wb, 'Roster', [
    [
      'Ana Lopez',
      'ALopez@hfacpas.com',
      'Audit',
      'Dana Ferris',
      'CSA-1',
      'Active',
      'dferris@hfacpas.com',
      80,
      null,
      'No',
      null,
    ],
    [
      'Ben Ito',
      { text: 'bito@hfacpas.com', hyperlink: 'mailto:bito@hfacpas.com' },
      'Tax',
      'Dana Ferris',
      'CSA-2',
      'Active',
      'dferris@hfacpas.com',
      '75%',
      30,
      'No',
      new Date(Date.UTC(2026, 8, 14)),
    ],
    [
      'Pat Partner',
      'ppartner@hfacpas.com',
      'Admin',
      null,
      null,
      'Active',
      null,
      null,
      null,
      'Yes',
      null,
    ],
    [
      'Old Timer',
      'otimer@hfacpas.com',
      'Tax',
      'Dana Ferris',
      'CSA-1',
      'Inactive',
      null,
      0.8,
      null,
      null,
      null,
    ],
  ]);
  rows(wb, 'Recipients', [
    ['CSA', 'CSA-1', 'Casey CSA', 'ccsa@hfacpas.com'],
    ['CSA', 'CSA-2', 'Drew CSA', 'dcsa@hfacpas.com'],
    ['Partner', null, 'Pat Partner', 'ppartner@hfacpas.com'],
  ]);
  rows(wb, 'Task Types', [
    ['Audit Fieldwork', 'Billable'],
    ['Admin', 'Non-billable'],
    ['PTO', 'PTO'],
    ['Sick Leave', 'Sick'],
  ]);
  rows(wb, 'Holidays', [
    [new Date(Date.UTC(2026, 10, 26)), 'Thanksgiving'],
    ['12/25/2026', 'Christmas'],
  ]);
};

describe('roster workbook', () => {
  it('the blank template parses, warning about its example rows and empty tabs', async () => {
    const parsed = await parseRosterWorkbook(await buildTemplateWorkbook());
    expect(parsed.problems).toEqual([]);
    expect(parsed.roster.members).toHaveLength(3);
    expect(parsed.warnings.join('\n')).toContain("template's example rows");
    expect(parsed.warnings.join('\n')).toContain('No Partner');
    expect(parsed.warnings.join('\n')).toContain('Task Types tab is empty');
  });

  it('reads a filled-in workbook', async () => {
    const parsed = await parseRosterWorkbook(await workbook(GOOD));
    expect(parsed.problems).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    const { members, recipients, taskTypes, holidays } = parsed.roster;
    expect(members.map((m) => m.email)).toEqual([
      'alopez@hfacpas.com',
      'bito@hfacpas.com',
      'ppartner@hfacpas.com',
      'otimer@hfacpas.com',
    ]);
    expect(members[1]).toMatchObject({
      name: 'Ben Ito',
      utilizationTarget: 0.75,
      expectedWeeklyHours: 30,
      hireDate: '2026-09-14',
      csaSlot: 'CSA-2',
    });
    expect(members[2]).toMatchObject({ excluded: true, managerEmail: null });
    expect(members[3]).toMatchObject({ active: false, utilizationTarget: 0.8 });
    expect(recipients).toEqual([
      { role: 'csa', slot: 'CSA-1', name: 'Casey CSA', email: 'ccsa@hfacpas.com' },
      { role: 'csa', slot: 'CSA-2', name: 'Drew CSA', email: 'dcsa@hfacpas.com' },
      { role: 'partner', slot: null, name: 'Pat Partner', email: 'ppartner@hfacpas.com' },
    ]);
    expect([...taskTypes]).toEqual([
      ['audit fieldwork', 'billable'],
      ['admin', 'non_billable'],
      ['pto', 'pto'],
      ['sick leave', 'sick'],
    ]);
    expect(holidays).toEqual([
      { date: '2026-11-26', name: 'Thanksgiving' },
      { date: '2026-12-25', name: 'Christmas' },
    ]);
  });

  it('rejects bad rows with row numbers, and catches duplicates', async () => {
    const parsed = await parseRosterWorkbook(
      await workbook((wb) => {
        GOOD(wb);
        rows(wb, 'Roster', [
          ['Ana Lopez', 'not-an-email', 'Audit', null, 'CSA-1', 'Active'],
          [
            'Ben Ito',
            'bito@hfacpas.com',
            null,
            null,
            'CSA-1',
            'Maybe',
            null,
            150,
            99,
            'Sometimes',
            'soon',
          ],
          ['Ben Again', 'BITO@hfacpas.com', 'Tax', null, 'CSA-1', 'Active'],
        ]);
        rows(wb, 'Task Types', [
          ['Audit Fieldwork', 'Billable'],
          ['audit fieldwork', 'PTO'],
          ['Mystery', 'Sometimes'],
        ]);
      }),
    );
    expect(parsed.problems).toEqual(
      expect.arrayContaining([
        'Roster row 3: Email "not-an-email" is not an email address.',
        'Roster row 4: Department is blank.',
        'Roster row 4: Status must be Active or Inactive (found "Maybe").',
        'Roster row 4: Utilization Target % must be 0–100.',
        'Roster row 4: Expected Weekly Hours must be a number from 0 to 80.',
        'Roster row 4: Exclude From Checks must be Yes or No.',
        'Roster row 4: Hire Date is not a date.',
        'Roster row 5: bito@hfacpas.com is already on row 4.',
        'Task Types row 4: "audit fieldwork" is listed twice with different categories.',
        'Task Types row 5: Category must be Billable, Non-billable, PTO or Sick (found "Sometimes").',
      ]),
    );
  });

  it("rejects the firm's original six-column template with a clear message", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Roster');
    ws.getRow(1).values = ['Blue rows are examples'];
    ws.getRow(2).values = [
      'Employee Name',
      'Email',
      'Department',
      'Manager',
      'CSA Assigned',
      'Status',
    ];
    ws.getRow(3).values = [
      'Jordan Alvarez',
      'jalvarez@hfacpas.com',
      'Audit',
      'Dana Ferris',
      'CSA-1',
      'Active',
    ];
    const parsed = await parseRosterWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(parsed.problems).toEqual([
      'The workbook has no "Recipients" tab.',
      'The workbook has no "Task Types" tab.',
      'The Roster tab is missing column(s): Manager Email, Utilization Target %, Expected Weekly Hours, Exclude From Checks, Hire Date.',
    ]);
  });
});

describe('roster diff', () => {
  it('lists adds, removals and field changes', () => {
    const a = member({ name: 'Ana Lopez' });
    const b = member({ name: 'Ben Ito' });
    const c = member({ name: 'Cal Ray' });
    const before = roster([a, b]);
    const after = roster([{ ...a, department: 'Tax', utilizationTarget: 0.75 }, c]);
    expect(describeDiff(diffRoster(before, after))).toEqual([
      '+ Cal Ray <cal.ray@hfacpas.com>',
      '- Ben Ito <ben.ito@hfacpas.com>',
      '~ Ana Lopez: department, target',
    ]);
    expect(describeDiff(diffRoster(before, before))).toEqual(['No changes.']);
  });
});
