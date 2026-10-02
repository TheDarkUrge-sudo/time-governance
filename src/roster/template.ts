/**
 * The roster workbook template: the firm's HFA_Staff_Roster_Template.xlsx,
 * extended per the plan with five Roster columns and three tabs (Recipients,
 * Task Types, Holidays). `pnpm template` writes it to templates/.
 */
import ExcelJS from 'exceljs';

export const ROSTER_HEADERS = [
  'Employee Name',
  'Email',
  'Department',
  'Manager',
  'CSA Assigned',
  'Status',
  'Manager Email',
  'Utilization Target %',
  'Expected Weekly Hours',
  'Exclude From Checks',
  'Hire Date',
] as const;
export const RECIPIENT_HEADERS = ['Role', 'CSA Slot', 'Name', 'Email', 'Karbon Client ID'] as const;
export const TASK_TYPE_HEADERS = ['Task Type', 'Category'] as const;
export const HOLIDAY_HEADERS = ['Date', 'Holiday'] as const;

export const DEPARTMENTS = ['Audit', 'Tax', 'Bookkeeping', 'Advisory', 'Admin'];
export const STATUSES = ['Active', 'Inactive'];
export const CSA_SLOTS = ['CSA-1', 'CSA-2', 'CSA-3'];
export const CATEGORIES = ['Billable', 'Non-billable', 'PTO', 'Sick'];
export const ROLES = ['CSA', 'Partner', 'Manager'];
export const YES_NO = ['Yes', 'No'];

const BRAND = 'FFBA2025';
const EXAMPLE_FILL = 'FFDCE6F2'; // the original template's blue example rows

const MAX_ROWS = 500;

export async function buildTemplateWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'HFA Time Governance';

  const roster = wb.addWorksheet('Roster');
  note(
    roster,
    'Blue rows are examples — replace with real data. Department, Status, CSA Assigned and Exclude use dropdowns (see Lists). Target is a percent (80). Blank Expected Weekly Hours = full time.',
    ROSTER_HEADERS.length,
  );
  header(roster, ROSTER_HEADERS);
  const examples = [
    [
      'Jordan Alvarez',
      'jalvarez@hfacpas.com',
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
      'Riley Chen',
      'rchen@hfacpas.com',
      'Tax',
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
      'Morgan Okafor',
      'mokafor@hfacpas.com',
      'Bookkeeping',
      'Sam Patel',
      'CSA-2',
      'Active',
      'spatel@hfacpas.com',
      80,
      30,
      'No',
      null,
    ],
  ];
  examples.forEach((row, i) => {
    const r = roster.getRow(3 + i);
    r.values = row;
    r.eachCell({ includeEmpty: true }, (c) => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EXAMPLE_FILL } };
    });
  });
  widths(roster, [22, 28, 14, 18, 13, 10, 28, 20, 21, 19, 12]);
  list(roster, 'C', 'Lists!$A$2:$A$20');
  list(roster, 'E', 'Lists!$C$2:$C$20');
  list(roster, 'F', 'Lists!$B$2:$B$3');
  list(roster, 'J', 'Lists!$E$2:$E$3');
  for (let r = 3; r <= MAX_ROWS; r++) {
    roster.getCell(`K${r}`).numFmt = 'yyyy-mm-dd';
    roster.getCell(`H${r}`).dataValidation = {
      type: 'decimal',
      operator: 'between',
      allowBlank: true,
      formulae: [0, 100],
      showErrorMessage: true,
      error: 'Enter a percent between 0 and 100 (e.g. 80).',
    };
  }

  const recipients = wb.addWorksheet('Recipients');
  note(
    recipients,
    'Who receives each email: one row per CSA slot (Tuesday review) and one per Partner (Friday escalation). Karbon Client ID (optional) = that person’s Hidden Governance client in Karbon, where their notes are kept. Add Manager rows only to give a manager a Governance client — manager emails come from the Roster.',
    RECIPIENT_HEADERS.length,
  );
  recipients.getRow(1).height = 48;
  header(recipients, RECIPIENT_HEADERS);
  widths(recipients, [12, 12, 24, 30, 18]);
  list(recipients, 'A', 'Lists!$F$2:$F$4');
  list(recipients, 'B', 'Lists!$C$2:$C$20');

  const tasks = wb.addWorksheet('Task Types');
  note(
    tasks,
    'Every Karbon task type, with how it counts. Run `pnpm tg karbon:task-types` to list the task types used in Karbon recently; any type missing here is reported each week.',
    TASK_TYPE_HEADERS.length,
  );
  header(tasks, TASK_TYPE_HEADERS);
  widths(tasks, [40, 16]);
  list(tasks, 'B', 'Lists!$D$2:$D$5');

  const holidays = wb.addWorksheet('Holidays');
  note(
    holidays,
    'Firm holidays. A weekday holiday lowers that week’s minimal-time line and the month’s capacity.',
    2,
  );
  header(holidays, HOLIDAY_HEADERS);
  widths(holidays, [14, 30]);
  for (let r = 3; r <= 100; r++) holidays.getCell(`A${r}`).numFmt = 'yyyy-mm-dd';

  const lists = wb.addWorksheet('Lists');
  lists.getRow(1).values = ['Departments', 'Status', 'CSA Assigned', 'Category', 'Yes/No', 'Role'];
  lists.getRow(1).font = { bold: true };
  const columns = [DEPARTMENTS, STATUSES, CSA_SLOTS, CATEGORIES, YES_NO, ROLES];
  columns.forEach((values, c) =>
    values.forEach((v, r) => {
      lists.getCell(r + 2, c + 1).value = v;
    }),
  );
  widths(lists, [16, 10, 14, 14, 9, 10]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function note(ws: ExcelJS.Worksheet, text: string, span: number): void {
  ws.mergeCells(1, 1, 1, span);
  const c = ws.getCell(1, 1);
  c.value = text;
  c.font = { italic: true, color: { argb: 'FF595959' } };
  c.alignment = { wrapText: true, vertical: 'middle' };
  ws.getRow(1).height = 32;
}

function header(ws: ExcelJS.Worksheet, labels: readonly string[]): void {
  const row = ws.getRow(2);
  row.values = [...labels];
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
  });
  ws.views = [{ state: 'frozen', ySplit: 2 }];
}

function widths(ws: ExcelJS.Worksheet, w: number[]): void {
  w.forEach((width, i) => {
    ws.getColumn(i + 1).width = width;
  });
}

function list(ws: ExcelJS.Worksheet, col: string, range: string): void {
  for (let r = 3; r <= MAX_ROWS; r++) {
    ws.getCell(`${col}${r}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [range],
    };
  }
}
