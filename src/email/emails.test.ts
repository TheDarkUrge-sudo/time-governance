import { describe, expect, it } from 'vitest';

import { member } from '../test-fixtures';
import { renderCsaWeekly } from './csa-weekly';
import { CHARCOAL, wrapEmail } from './layout';
import { renderManagerMonthly } from './manager-monthly';
import { renderPartnerEscalation } from './partner-escalation';

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
          timesheetKey: null,
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
    const withTable = renderManagerMonthly({
      month: '2026-09',
      previousMonth: '2026-08',
      managerName: null,
      rows: [],
      dropPoints: 10,
    });
    expect(withTable.bodyHtml).toContain(`background-color:${CHARCOAL}`);
    expect(withTable.bodyHtml).not.toContain('#BA2025');
  });

  it('orders the CSA table by check, then name', () => {
    const p = (name: string, kind: 'no_entry' | 'minimal_entry' | 'ad_hoc_work') => ({
      member: member({ name }),
      karbonUserId: name,
      minutes: { total: 0, billable: 0, nonBillable: 0, pto: 0, sick: 0, unclassified: 0 },
      minimalThresholdMinutes: 1200,
      timesheetKey: null,
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
      previousMonth: '2026-08',
      managerName: null,
      rows: [row(0.8, 0.79)],
      dropPoints: 10,
    });
    expect(one.text).toContain('Quinn Foster is 1 point under target.');
    const tiny = renderManagerMonthly({
      month: '2026-09',
      previousMonth: '2026-08',
      managerName: null,
      rows: [row(0.8, 0.798)],
      dropPoints: 10,
    });
    expect(tiny.text).toContain('Quinn Foster is just under target.');
  });

  it('lists the entries behind a flag, up to five, then "+N more"', () => {
    const entries = Array.from({ length: 7 }, (_, i) => ({
      date: '2026-09-22',
      client: 'Acme Corp',
      minutes: 60 + i,
      taskType: 'Admin',
      role: 'Staff',
      description: i === 0 ? null : 'call',
    }));
    const email = renderCsaWeekly({
      week,
      csaName: null,
      unmatched: [],
      people: [
        {
          member: member({ name: 'Sam Nguyen' }),
          karbonUserId: 'k',
          minutes: {
            total: 2400,
            billable: 2000,
            nonBillable: 400,
            pto: 0,
            sick: 0,
            unclassified: 0,
          },
          minimalThresholdMinutes: 1200,
          timesheetKey: null,
          flags: [{ kind: 'nonbillable_unexplained', minutes: 427, detail: '7 entries', entries }],
        },
      ],
    });
    expect(email.text).toContain('    Tue Sep 22 · Acme Corp · 1.0 h · Admin · (no description)');
    expect(email.text).toContain('    Tue Sep 22 · Acme Corp · 1.0 h · Admin · “call”');
    expect(email.text).toContain('    +2 more entries');
    expect(email.bodyHtml).toContain('Tue Sep 22 · Acme Corp · 1.0 h · Admin · “call”');
  });

  it('shows the month-over-month trend and calls out drops', () => {
    const row = (name: string, utilization: number, previousUtilization: number | null) => ({
      member: member({ name }),
      minutes: { total: 0, billable: 0, nonBillable: 0, pto: 0, sick: 0, unclassified: 0 },
      capacityMinutes: 6000,
      capacitySource: 'karbon' as const,
      utilization,
      previousUtilization,
      target: 0.8,
      underTarget: utilization < 0.8,
    });
    const email = renderManagerMonthly({
      month: '2026-09',
      previousMonth: '2026-08',
      managerName: 'Dana Ferris',
      dropPoints: 10,
      rows: [
        row('Riley Chen', 0.44, 0.52), // under target, falling
        row('Avery Kim', 0.83, 0.95), // above target, but a sharp drop
        row('Jamie Ortiz', 0.87, 0.84), // fine
        row('New Hire', 0.85, null), // nothing to compare
      ],
    });
    expect(email.bodyHtml).toContain('vs. Aug');
    expect(email.bodyHtml).toContain('▼ 8');
    expect(email.bodyHtml).toContain('▲ 3');
    expect(email.text).toContain('Riley Chen is 36 points under target, down 8 from August.');
    expect(email.text).toContain(
      'Avery Kim dropped 12 points from August, though still at target.',
    );
    expect(email.text).not.toContain('Jamie Ortiz dropped');
    expect(email.text).toContain('utilization 87% (target 80%), vs Aug 84% ▲ 3');
    expect(email.text).toMatch(/New Hire .*utilization 85% \(target 80%\)\n/);
  });

  it('Partner email: year-to-date count, and a year-long pattern counts as a repeat', () => {
    const row = (name: string, weeksFlagged: number, thisYear: number) => ({
      member: member({ name }),
      kind: 'no_entry' as const,
      minutes: 0,
      weeksFlagged,
      lookbackWeeks: 4,
      thisYear,
    });
    const email = renderPartnerEscalation({
      week,
      historyStartsWeek: null,
      lookbackWeeks: 4,
      rows: [row('Riley Chen', 3, 9), row('Avery Kim', 1, 6), row('Jamie Ortiz', 1, 1)],
    });
    expect(email.text).toContain(
      'Riley Chen has now been flagged 3 of the last 4 weeks (9 this year).',
    );
    expect(email.text).toContain('Avery Kim has been escalated 6 times this year.');
    expect(email.text).not.toContain('Jamie Ortiz has');
    expect(email.text).toContain(
      'Jamie Ortiz (Audit; manager Dana Ferris): No entry, flagged 1 of the last 4 weeks\n',
    );
    expect(email.bodyHtml).toContain('9 this year');
  });

  it('says so plainly when there is nothing to flag', () => {
    const email = renderCsaWeekly({ week, csaName: 'Casey', unmatched: [], people: [] });
    expect(email.subject).toBe('Weekly time entry review: week of Sep 21 — no flags');
    expect(email.text).toContain('No flags this week.');
  });
});
