import { describe, expect, it } from 'vitest';

import {
  addDays,
  firmLocalDate,
  isIsoDate,
  isMonthlyReportDay,
  mondayOf,
  monthRange,
  previousMonth,
  previousWeek,
  shortDate,
  weekdayHolidays,
  workingDays,
} from './calendar';

describe('calendar', () => {
  it('reads the firm-local date, not the UTC one', () => {
    // 01:30 UTC Tuesday is still Monday evening in New York.
    expect(firmLocalDate(new Date('2026-09-29T01:30:00Z'), 'America/New_York')).toBe('2026-09-28');
  });

  it('finds the Monday of any day, Sunday included', () => {
    expect(mondayOf('2026-09-28')).toBe('2026-09-28'); // Monday
    expect(mondayOf('2026-10-01')).toBe('2026-09-28'); // Thursday
    expect(mondayOf('2026-10-04')).toBe('2026-09-28'); // Sunday
  });

  it('previous week is the last full Monday–Sunday', () => {
    expect(previousWeek('2026-09-29')).toEqual({ start: '2026-09-21', end: '2026-09-27' });
    expect(previousWeek('2026-10-02')).toEqual({ start: '2026-09-21', end: '2026-09-27' });
  });

  it('month ranges handle December and leap years', () => {
    expect(monthRange('2026-12')).toEqual({ start: '2026-12-01', end: '2026-12-31' });
    expect(monthRange('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(previousMonth('2026-01-12')).toBe('2025-12');
    expect(() => monthRange('2026-9')).toThrow();
  });

  it('monthly report day = first Monday on or after the 8th', () => {
    expect(isMonthlyReportDay('2026-10-12')).toBe(true);
    expect(isMonthlyReportDay('2026-10-05')).toBe(false); // first Monday, but before the 8th
    expect(isMonthlyReportDay('2026-10-19')).toBe(false);
    expect(isMonthlyReportDay('2026-06-08')).toBe(true); // the 8th itself
    expect(isMonthlyReportDay('2026-10-13')).toBe(false); // Tuesday
  });

  it('working days skip weekends and weekday holidays only', () => {
    const range = { start: '2026-11-23', end: '2026-11-29' };
    const holidays = [
      { date: '2026-11-26', name: 'Thanksgiving' },
      { date: '2026-11-28', name: 'A Saturday' },
    ];
    expect(workingDays(range, holidays)).toEqual([
      '2026-11-23',
      '2026-11-24',
      '2026-11-25',
      '2026-11-27',
    ]);
    expect(weekdayHolidays(range, holidays).map((h) => h.name)).toEqual(['Thanksgiving']);
  });

  it('validates and formats dates', () => {
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(shortDate('2026-09-21')).toBe('Sep 21');
  });
});
