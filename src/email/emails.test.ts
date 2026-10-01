import { describe, expect, it } from 'vitest';

import { member } from '../test-fixtures';
import { renderCsaWeekly } from './csa-weekly';
import { CHARCOAL, wrapEmail } from './layout';
import { renderManagerMonthly } from './manager-monthly';

const week = { start: '2026-09-21', end: '2026-09-27' };

describe('emails', () => {
  it('escapes everything that comes from the roster or Karbon', () => {
    const evil = member({ name: '<script>alert(1)</script>', department: 'Tax & "Advisory"' });
    const email = renderCsaWeekly({
      week,
      csaName: "O'Brien <csa>",
      unmatched: [],
      people: [
        {
          member: evil,
          karbonUserId: 'k',
          minutes: { total: 0, billable: 0, nonBillable: 0, pto: 0, sick: 0, unclassified: 0 },
          minimalThresholdMinutes: 1200,
          flags: [
            {
              kind: 'internal_only_role',
              minutes: 60,
              detail: '(Internal Only) role on <b>Acme</b>',
            },
          ],
        },
      ],
    });
    expect(email.bodyHtml).not.toContain('<script>');
    expect(email.bodyHtml).toContain('&lt;script&gt;');
    expect(email.bodyHtml).toContain('Tax &amp; &quot;Advisory&quot;');
    expect(email.bodyHtml).toContain('&lt;b&gt;Acme&lt;/b&gt;');
    expect(email.bodyHtml).toContain('O&#39;Brien &lt;csa&gt;');
  });

  it('keeps brand red to the top bar; tables get a neutral header', () => {
    const html = wrapEmail(
      renderCsaWeekly({ week, csaName: null, unmatched: [], people: [] }).bodyHtml,
    );
    expect(html.match(/#BA2025/g)).toHaveLength(1);
    expect(html).not.toMatch(/#8B1A1A/i);
    const withTable = renderManagerMonthly({ month: '2026-09', managerName: null, rows: [] });
    expect(withTable.bodyHtml).toContain(`background-color:${CHARCOAL}`);
    expect(withTable.bodyHtml).not.toContain('#BA2025');
  });

  it('orders the CSA table by check, then name', () => {
    const p = (name: string, kind: 'no_entry' | 'minimal_entry' | 'ad_hoc_work') => ({
      member: member({ name }),
      karbonUserId: name,
      minutes: { total: 0, billable: 0, nonBillable: 0, pto: 0, sick: 0, unclassified: 0 },
      minimalThresholdMinutes: 1200,
      flags: [{ kind, minutes: 0, detail: kind }],
    });
    const email = renderCsaWeekly({
      week,
      csaName: null,
      unmatched: [],
      people: [p('Ann Ad', 'ad_hoc_work'), p('Zed None', 'no_entry'), p('Bo Min', 'minimal_entry')],
    });
    expect(email.text.indexOf('Zed None')).toBeLessThan(email.text.indexOf('Bo Min'));
    expect(email.text.indexOf('Bo Min')).toBeLessThan(email.text.indexOf('Ann Ad'));
  });

  it('says "1 point", not "1 points"', () => {
    const row = (target: number, utilization: number) => ({
      member: member({ name: 'Quinn Foster' }),
      minutes: { total: 0, billable: 0, nonBillable: 0, pto: 0, sick: 0, unclassified: 0 },
      capacityMinutes: 6000,
      capacitySource: 'karbon' as const,
      utilization,
      target,
      underTarget: true,
    });
    const one = renderManagerMonthly({
      month: '2026-09',
      managerName: null,
      rows: [row(0.8, 0.79)],
    });
    expect(one.text).toContain('Quinn Foster is 1 point under target.');
    const tiny = renderManagerMonthly({
      month: '2026-09',
      managerName: null,
      rows: [row(0.8, 0.798)],
    });
    expect(tiny.text).toContain('Quinn Foster is just under target.');
  });

  it('says so plainly when there is nothing to flag', () => {
    const email = renderCsaWeekly({ week, csaName: 'Casey', unmatched: [], people: [] });
    expect(email.subject).toBe('Weekly time entry review: week of Sep 21 — no flags');
    expect(email.text).toContain('No flags this week.');
  });
});
