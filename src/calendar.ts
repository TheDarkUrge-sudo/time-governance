/**
 * Calendar math on firm-local YYYY-MM-DD dates. Pure: the only clock input is
 * the `now` a caller passes in, and the local date always comes from an
 * Intl formatter in the firm's timezone — never from toISOString() (UTC),
 * which reads Monday 9 PM Eastern as Tuesday.
 */
import type { DateRange, Holiday } from './domain';

const DAY_MS = 86_400_000;
const utcMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

export function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(utcMs(s)) && toIso(utcMs(s)) === s;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  return toIso(utcMs(iso) + n * DAY_MS);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(iso: string): number {
  return new Date(utcMs(iso)).getUTCDay();
}

export function firmLocalDate(now: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The firm-local date and minutes past midnight (0–1439) at `now`. */
export function firmLocalTime(now: Date, timeZone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const num = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { date: firmLocalDate(now, timeZone), minutes: num('hour') * 60 + num('minute') };
}

/** The Monday of the week containing `iso`. */
export function mondayOf(iso: string): string {
  return addDays(iso, -((weekday(iso) + 6) % 7));
}

/** Monday–Sunday of the week starting `monday`. */
export function weekOf(monday: string): DateRange {
  return { start: monday, end: addDays(monday, 6) };
}

/** The previous full Monday–Sunday week, as seen on `today` (plan decision 6). */
export function previousWeek(today: string): DateRange {
  return weekOf(addDays(mondayOf(today), -7));
}

/** The calendar month `yyyy-mm`. */
export function monthRange(month: string): DateRange {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`Not a month (YYYY-MM): ${month}`);
  const start = `${month}-01`;
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { start, end: addDays(next, -1) };
}

export function previousMonth(today: string): string {
  const [y, m] = today.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/**
 * The monthly report runs in week 2: the first Monday on or after the 8th.
 * By then the prior month's time has had a full week to be corrected.
 */
export function isMonthlyReportDay(today: string): boolean {
  const day = Number(today.slice(8, 10));
  return weekday(today) === 1 && day >= 8 && day <= 14;
}

export function datesIn(range: DateRange): string[] {
  const out: string[] = [];
  for (let d = range.start; d <= range.end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Monday–Friday dates in the range that are not firm holidays. */
export function workingDays(range: DateRange, holidays: readonly Holiday[]): string[] {
  const off = new Set(holidays.map((h) => h.date));
  return datesIn(range).filter((d) => {
    const wd = weekday(d);
    return wd >= 1 && wd <= 5 && !off.has(d);
  });
}

/** Holidays that fall on a weekday inside the range. */
export function weekdayHolidays(range: DateRange, holidays: readonly Holiday[]): Holiday[] {
  return holidays.filter((h) => {
    const wd = weekday(h.date);
    return h.date >= range.start && h.date <= range.end && wd >= 1 && wd <= 5;
  });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Tue Sep 22" */
export function dayLabel(iso: string): string {
  return `${WEEKDAYS[weekday(iso)]} ${shortDate(iso)}`;
}

/** "Sep 21" */
export function shortDate(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
}

/** "Aug" for 2026-08 */
export function shortMonth(month: string): string {
  return MONTHS[Number(month.slice(5, 7)) - 1]!;
}

/** "August" for 2026-08 */
export function monthName(month: string): string {
  return LONG_MONTHS[Number(month.slice(5, 7)) - 1]!;
}

/** "September 2026" */
export function monthLabel(month: string): string {
  return `${LONG_MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}
