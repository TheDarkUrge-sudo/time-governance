/**
 * Reads the roster workbook (templates/HFA_Staff_Roster_Template.xlsx layout)
 * into a Roster. Strict: any problem rejects the whole file with row-level
 * messages, because a half-imported roster would silently send emails to the
 * wrong people. Warnings (e.g. a CSA slot nobody receives) don't block.
 */
import ExcelJS from 'exceljs';
import { z } from 'zod/v4';

import { isIsoDate } from '../calendar';
import type { Holiday, Recipient, Roster, RosterMember, TaskCategory } from '../domain';

export interface ParsedWorkbook {
  roster: Roster;
  problems: string[];
  warnings: string[];
}

const TEMPLATE_EXAMPLE_EMAILS = new Set([
  'jalvarez@hfacpas.com',
  'rchen@hfacpas.com',
  'mokafor@hfacpas.com',
]);

const CATEGORY_BY_LABEL: Record<string, TaskCategory> = {
  billable: 'billable',
  'non-billable': 'non_billable',
  nonbillable: 'non_billable',
  'non billable': 'non_billable',
  pto: 'pto',
  sick: 'sick',
};

const emailSchema = z.email();

/** parseDate's "there was something, but it isn't a date". */
const INVALID = Symbol('invalid date');

export async function parseRosterWorkbook(data: Buffer | ArrayBuffer): Promise<ParsedWorkbook> {
  const wb = new ExcelJS.Workbook();
  // exceljs's load() signature predates Node's generic Buffer type.
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const problems: string[] = [];
  const warnings: string[] = [];

  const sheet = (name: string) =>
    wb.worksheets.find((w) => w.name.trim().toLowerCase() === name.toLowerCase());

  const rosterSheet = sheet('Roster');
  const recipientSheet = sheet('Recipients');
  const taskSheet = sheet('Task Types');
  const holidaySheet = sheet('Holidays');
  if (!rosterSheet) problems.push('The workbook has no "Roster" tab.');
  if (!recipientSheet) problems.push('The workbook has no "Recipients" tab.');
  if (!taskSheet) problems.push('The workbook has no "Task Types" tab.');

  const members = rosterSheet ? readMembers(rosterSheet, problems, warnings) : [];
  const recipients = recipientSheet ? readRecipients(recipientSheet, problems) : [];
  const taskTypes = taskSheet
    ? readTaskTypes(taskSheet, problems)
    : new Map<string, TaskCategory>();
  const holidays = holidaySheet ? readHolidays(holidaySheet, problems) : [];

  // Cross-tab checks.
  const csaSlots = new Set(recipients.filter((r) => r.role === 'csa').map((r) => r.slot));
  const unreceived = new Set<string>();
  for (const m of members) {
    if (!m.active || m.excluded) continue;
    if (!m.csaSlot) warnings.push(`${m.name} has no CSA Assigned, so no CSA will see their flags.`);
    else if (!csaSlots.has(m.csaSlot)) unreceived.add(m.csaSlot);
    if (!m.managerEmail) {
      warnings.push(`${m.name} has no Manager Email, so they won't appear in a monthly report.`);
    }
  }
  for (const slot of unreceived) {
    warnings.push(`No one on the Recipients tab receives ${slot}'s Tuesday review.`);
  }
  if (!recipients.some((r) => r.role === 'partner')) {
    warnings.push(
      'No Partner on the Recipients tab, so the Friday escalation has nobody to go to.',
    );
  }
  const rosterUnreadable = problems.some((p) => p.startsWith('The Roster tab'));
  if (members.length === 0 && rosterSheet && !rosterUnreadable) {
    problems.push('The Roster tab has no employees.');
  }
  if (taskTypes.size === 0 && taskSheet) {
    warnings.push(
      'The Task Types tab is empty, so no time can be classified as billable, PTO or sick.',
    );
  }

  return { roster: { members, recipients, taskTypes, holidays }, problems, warnings };
}

/* ── Tabs ───────────────────────────────────────────────────────────────── */

function readMembers(
  ws: ExcelJS.Worksheet,
  problems: string[],
  warnings: string[],
): RosterMember[] {
  const cols = headerColumns(ws, 'Employee Name', problems, {
    name: 'Employee Name',
    email: 'Email',
    department: 'Department',
    manager: 'Manager',
    csa: 'CSA Assigned',
    status: 'Status',
    managerEmail: 'Manager Email',
    target: 'Utilization Target %',
    hours: 'Expected Weekly Hours',
    exclude: 'Exclude From Checks',
    hire: 'Hire Date',
  });
  if (!cols) return [];
  const out: RosterMember[] = [];
  const seen = new Map<string, number>();
  eachDataRow(ws, cols.headerRow, (row, n) => {
    const at = `Roster row ${n}`;
    const get = (key: keyof typeof cols.map) => cellText(row, cols.map[key]);
    const name = get('name');
    const rawEmail = get('email').toLowerCase();
    if (!name && !rawEmail) return;
    if (!name) problems.push(`${at}: Employee Name is blank.`);
    const email = checkEmail(rawEmail, `${at}: Email`, problems, true);
    if (email && seen.has(email)) {
      problems.push(`${at}: ${email} is already on row ${seen.get(email)}.`);
    }
    if (email) seen.set(email, n);
    if (email && TEMPLATE_EXAMPLE_EMAILS.has(email)) {
      warnings.push(
        `${at}: ${email} is one of the template's example rows — delete it if it isn't real.`,
      );
    }

    const department = get('department');
    if (!department) problems.push(`${at}: Department is blank.`);

    const status = get('status').toLowerCase();
    if (status !== 'active' && status !== 'inactive') {
      problems.push(`${at}: Status must be Active or Inactive (found "${get('status')}").`);
    }

    const target = parsePercent(cellValue(row, cols.map.target));
    if (target === 'invalid') problems.push(`${at}: Utilization Target % must be 0–100.`);

    const hoursRaw = cellValue(row, cols.map.hours);
    let expectedWeeklyHours: number | null = null;
    if (hoursRaw !== null && hoursRaw !== '') {
      const h = Number(typeof hoursRaw === 'string' ? hoursRaw.trim() : hoursRaw);
      if (!Number.isFinite(h) || h < 0 || h > 80) {
        problems.push(`${at}: Expected Weekly Hours must be a number from 0 to 80.`);
      } else expectedWeeklyHours = h;
    }

    const exclude = parseYesNo(get('exclude'));
    if (exclude === 'invalid') problems.push(`${at}: Exclude From Checks must be Yes or No.`);

    const hire = parseDate(cellValue(row, cols.map.hire));
    if (hire === INVALID) problems.push(`${at}: Hire Date is not a date.`);

    const managerEmail = checkEmail(
      get('managerEmail').toLowerCase(),
      `${at}: Manager Email`,
      problems,
      false,
    );

    out.push({
      name,
      email: email ?? rawEmail,
      department,
      managerName: get('manager') || null,
      managerEmail,
      csaSlot: get('csa') || null,
      active: status === 'active',
      utilizationTarget: target === 'invalid' ? null : target,
      expectedWeeklyHours,
      excluded: exclude === true,
      hireDate: hire === INVALID ? null : hire,
    });
  });
  return out;
}

function readRecipients(ws: ExcelJS.Worksheet, problems: string[]): Recipient[] {
  const cols = headerColumns(ws, 'Role', problems, {
    role: 'Role',
    slot: 'CSA Slot',
    name: 'Name',
    email: 'Email',
  });
  if (!cols) return [];
  // Optional, so workbooks made before governance notes still import.
  const clientIdCol = optionalColumn(ws, cols.headerRow, 'Karbon Client ID');
  const out: Recipient[] = [];
  eachDataRow(ws, cols.headerRow, (row, n) => {
    const at = `Recipients row ${n}`;
    const role = cellText(row, cols.map.role).toLowerCase();
    const slot = cellText(row, cols.map.slot);
    const name = cellText(row, cols.map.name);
    const rawEmail = cellText(row, cols.map.email).toLowerCase();
    if (!role && !rawEmail && !name) return;
    if (role !== 'csa' && role !== 'partner' && role !== 'manager') {
      problems.push(`${at}: Role must be CSA, Partner or Manager.`);
      return;
    }
    if (role === 'csa' && !slot) problems.push(`${at}: a CSA row needs its CSA Slot.`);
    const karbonClientId = clientIdCol ? cellText(row, clientIdCol) || null : null;
    if (role === 'manager' && !karbonClientId) {
      problems.push(`${at}: a Manager row is only for linking a Karbon Client ID — add one.`);
    }
    const email = checkEmail(rawEmail, `${at}: Email`, problems, true);
    if (!email) return;
    out.push({
      role,
      slot: role === 'csa' ? slot : null,
      name: name || null,
      email,
      karbonClientId,
    });
  });
  return out;
}

function readTaskTypes(ws: ExcelJS.Worksheet, problems: string[]): Map<string, TaskCategory> {
  const cols = headerColumns(ws, 'Task Type', problems, {
    name: 'Task Type',
    category: 'Category',
  });
  const out = new Map<string, TaskCategory>();
  if (!cols) return out;
  eachDataRow(ws, cols.headerRow, (row, n) => {
    const at = `Task Types row ${n}`;
    const name = cellText(row, cols.map.name);
    const label = cellText(row, cols.map.category);
    if (!name && !label) return;
    if (!name) {
      problems.push(`${at}: Task Type is blank.`);
      return;
    }
    const category = CATEGORY_BY_LABEL[label.toLowerCase()];
    if (!category) {
      problems.push(
        `${at}: Category must be Billable, Non-billable, PTO or Sick (found "${label}").`,
      );
      return;
    }
    const key = name.toLowerCase();
    const existing = out.get(key);
    if (existing && existing !== category) {
      problems.push(`${at}: "${name}" is listed twice with different categories.`);
    }
    out.set(key, category);
  });
  return out;
}

function readHolidays(ws: ExcelJS.Worksheet, problems: string[]): Holiday[] {
  const cols = headerColumns(ws, 'Date', problems, { date: 'Date', name: 'Holiday' });
  if (!cols) return [];
  const out: Holiday[] = [];
  eachDataRow(ws, cols.headerRow, (row, n) => {
    const raw = cellValue(row, cols.map.date);
    const name = cellText(row, cols.map.name);
    if ((raw === null || raw === '') && !name) return;
    const date = parseDate(raw);
    if (date === INVALID || date === null) {
      problems.push(`Holidays row ${n}: Date is not a date.`);
      return;
    }
    out.push({ date, name: name || 'Holiday' });
  });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/* ── Cells ──────────────────────────────────────────────────────────────── */

/** Finds the header row (within the first 10 rows) by its first label; maps labels to columns. */
function headerColumns<K extends string>(
  ws: ExcelJS.Worksheet,
  anchor: string,
  problems: string[],
  labels: Record<K, string>,
): { headerRow: number; map: Record<K, number> } | null {
  for (let r = 1; r <= 10; r++) {
    const row = ws.getRow(r);
    const found = new Map<string, number>();
    row.eachCell((cell, col) => {
      found.set(textOf(cell.value).trim().toLowerCase(), col);
    });
    if (!found.has(anchor.toLowerCase())) continue;
    const map = {} as Record<K, number>;
    const missing: string[] = [];
    for (const [key, label] of Object.entries(labels) as [K, string][]) {
      const col = found.get(label.toLowerCase());
      if (col === undefined) missing.push(label);
      else map[key] = col;
    }
    if (missing.length > 0) {
      problems.push(`The ${ws.name} tab is missing column(s): ${missing.join(', ')}.`);
      return null;
    }
    return { headerRow: r, map };
  }
  problems.push(`The ${ws.name} tab has no "${anchor}" header row.`);
  return null;
}

/** A column that may be absent (older workbooks); its index, or null. */
function optionalColumn(ws: ExcelJS.Worksheet, headerRow: number, label: string): number | null {
  let found: number | null = null;
  ws.getRow(headerRow).eachCell((cell, col) => {
    if (textOf(cell.value).trim().toLowerCase() === label.toLowerCase()) found = col;
  });
  return found;
}

function eachDataRow(
  ws: ExcelJS.Worksheet,
  headerRow: number,
  fn: (row: ExcelJS.Row, n: number) => void,
): void {
  for (let r = headerRow + 1; r <= ws.rowCount; r++) fn(ws.getRow(r), r);
}

type Plain = string | number | boolean | Date | null;

function cellValue(row: ExcelJS.Row, col: number): Plain {
  return plain(row.getCell(col).value);
}

function cellText(row: ExcelJS.Row, col: number): string {
  return textOf(row.getCell(col).value).trim();
}

function plain(v: ExcelJS.CellValue): Plain {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('hyperlink' in v) {
      const text = textOf(v.text);
      return text || v.hyperlink.replace(/^mailto:/i, '');
    }
    if ('result' in v) return plain(v.result);
    if ('error' in v) return null;
  }
  return null;
}

function textOf(v: ExcelJS.CellValue): string {
  const p = plain(v);
  if (p === null) return '';
  if (p instanceof Date) return p.toISOString().slice(0, 10);
  return String(p);
}

function checkEmail(
  raw: string,
  label: string,
  problems: string[],
  required: boolean,
): string | null {
  const email = raw.replace(/^mailto:/i, '').trim();
  if (!email) {
    if (required) problems.push(`${label} is blank.`);
    return null;
  }
  if (!emailSchema.safeParse(email).success) {
    problems.push(`${label} "${email}" is not an email address.`);
    return null;
  }
  return email;
}

/** 80, "80", "80%" → 0.8; 0.8 → 0.8 (a fraction already). Blank → null. */
function parsePercent(v: Plain): number | null | 'invalid' {
  if (v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace('%', '').trim());
  if (!Number.isFinite(n) || n < 0 || n > 100) return 'invalid';
  return n > 1 ? n / 100 : n;
}

function parseYesNo(s: string): boolean | 'invalid' {
  const v = s.toLowerCase();
  if (v === '' || v === 'no' || v === 'n') return false;
  if (v === 'yes' || v === 'y') return true;
  return 'invalid';
}

/** A date cell (Excel date, ISO text, or US m/d/yyyy) → YYYY-MM-DD; blank → null. */
function parseDate(v: Plain): string | null | typeof INVALID {
  if (v === null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? INVALID : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (isIsoDate(s)) return s;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) {
    const iso = `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`;
    return isIsoDate(iso) ? iso : INVALID;
  }
  return INVALID;
}
