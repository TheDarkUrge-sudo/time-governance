import { describe, expect, it } from 'vitest';

import { timesheetUrl, timesheetUrlProblem } from './links';

const PATTERN = 'https://app2.karbonhq.com/AbCdEf123456/timesheet/{key}';

describe('Karbon links', () => {
  it('builds a timesheet address from the pattern and a Karbon key', () => {
    expect(timesheetUrl(PATTERN, '4bLnlnsHm4pM')).toBe(
      'https://app2.karbonhq.com/AbCdEf123456/timesheet/4bLnlnsHm4pM',
    );
  });

  it('gives no link without a pattern or with anything but a plain key', () => {
    expect(timesheetUrl(null, '4bLnlnsHm4pM')).toBeNull();
    expect(timesheetUrl(PATTERN, null)).toBeNull();
    expect(timesheetUrl(PATTERN, '../admin')).toBeNull();
    expect(timesheetUrl(PATTERN, 'a b"c')).toBeNull();
  });

  it('accepts only https karbonhq.com patterns with a {key}', () => {
    expect(timesheetUrlProblem(PATTERN)).toBeNull();
    expect(timesheetUrlProblem('https://app2.karbonhq.com/AbCdEf123456/timesheet/')).toMatch(
      /\{key\}/,
    );
    expect(timesheetUrlProblem('http://app2.karbonhq.com/x/timesheet/{key}')).toMatch(/https/);
    expect(timesheetUrlProblem('https://karbonhq.com.evil.test/{key}')).toMatch(/karbonhq\.com/);
    expect(timesheetUrlProblem('not a url {key}')).toMatch(/valid URL/);
  });
});
