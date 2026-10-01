/**
 * Renders the three emails (plus an admin summary) from SAMPLE data to
 * out/previews/*.html, for reviewing the layout without Karbon or SendGrid.
 * Usage: pnpm tsx scripts/preview-emails.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { EscalationRow } from '../src/checks/escalation';
import type { UtilizationRow } from '../src/checks/utilization';
import type { PersonWeek } from '../src/checks/weekly';
import type { RosterMember } from '../src/domain';
import { renderAdminSummary } from '../src/email/admin-summary';
import { renderCsaWeekly } from '../src/email/csa-weekly';
import { type EmailContent, wrapEmail } from '../src/email/layout';
import { renderManagerMonthly } from '../src/email/manager-monthly';
import { renderPartnerEscalation } from '../src/email/partner-escalation';

const m = (name: string, department: string): RosterMember => ({
  name,
  email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.com`,
  department,
  managerName: 'Dana Ferris',
  managerEmail: 'manager@example.com',
  csaSlot: 'CSA-1',
  active: true,
  utilizationTarget: 0.8,
  expectedWeeklyHours: null,
  excluded: false,
  hireDate: null,
});
const mins = (total: number) => ({
  total,
  billable: total,
  nonBillable: 0,
  pto: 0,
  sick: 0,
  unclassified: 0,
});
const person = (member: RosterMember, total: number, flags: PersonWeek['flags']): PersonWeek => ({
  member,
  karbonUserId: member.email,
  minutes: mins(total),
  minimalThresholdMinutes: 1200,
  flags,
});

const week = { start: '2026-09-21', end: '2026-09-27' };
const alvarez = m('Jordan Alvarez', 'Audit');
const chen = m('Riley Chen', 'Tax');

const emails: Record<string, EmailContent> = {
  'csa-weekly': renderCsaWeekly({
    week,
    csaName: 'Casey CSA',
    unmatched: [m('Sam New', 'Tax')],
    people: [
      person(alvarez, 0, [{ kind: 'no_entry', minutes: 0, detail: 'No time logged for the week' }]),
      person(chen, 210, [
        { kind: 'minimal_entry', minutes: 210, detail: '3.5 h logged; expected at least 20.0 h' },
      ]),
      person(m('Morgan Okafor', 'Bookkeeping'), 2400, [
        { kind: 'internal_only_role', minutes: 360, detail: '(Internal Only) role on Acme Corp' },
      ]),
      person(m('Taylor Brooks', 'Audit'), 2400, [
        {
          kind: 'internal_client_billable',
          minutes: 120,
          detail: '2.0 h billable on the internal HFA client',
        },
      ]),
      person(m('Sam Nguyen', 'Advisory'), 2400, [
        {
          kind: 'nonbillable_unexplained',
          minutes: 270,
          detail: '3 non-billable entries with no clear description',
        },
      ]),
      person(m('Kai Diallo', 'Tax'), 2400, [
        {
          kind: 'ad_hoc_work',
          minutes: 300,
          detail: "5.0 h on Acme Corp's Ad Hoc work item, 3 weeks running",
        },
      ]),
    ],
  }),
  'partner-escalation': renderPartnerEscalation({
    week,
    historyStartsWeek: '2026-09-07',
    lookbackWeeks: 4,
    rows: [
      { member: chen, kind: 'minimal_entry', minutes: 210, weeksFlagged: 3, lookbackWeeks: 4 },
      { member: alvarez, kind: 'no_entry', minutes: 0, weeksFlagged: 1, lookbackWeeks: 4 },
    ] satisfies EscalationRow[],
  }),
  'manager-monthly': renderManagerMonthly({
    month: '2026-09',
    managerName: 'Dana Ferris',
    rows: [
      [chen, 124, 18, 8, 0, 176],
      [m('Morgan Okafor', 'Bookkeeping'), 142, 12, 0, 8, 173],
      [alvarez, 131, 22, 16, 0, 160],
    ].map(([member, b, nb, pto, sick, cap]) => {
      const capacityMinutes = (cap as number) * 60;
      const utilization = ((b as number) * 60) / capacityMinutes;
      return {
        member: member as RosterMember,
        minutes: {
          total: 0,
          billable: (b as number) * 60,
          nonBillable: (nb as number) * 60,
          pto: (pto as number) * 60,
          sick: (sick as number) * 60,
          unclassified: 0,
        },
        capacityMinutes,
        capacitySource: 'karbon',
        utilization,
        target: 0.8,
        underTarget: utilization < 0.8,
      } satisfies UtilizationRow;
    }),
  }),
  'admin-summary': renderAdminSummary({
    title: 'Tuesday review run: week of Sep 21',
    sub: '42 people checked · 6 flags · Sep 21 – Sep 27',
    sections: [
      { title: 'Emails', lines: ['sent         csa_weekly → casey.csa@example.com'] },
      {
        title: 'Task types not on the Task Types tab',
        lines: ['Brand New Code: 3.0 h across 2 entries'],
      },
    ],
  }),
};

const out = path.resolve(import.meta.dirname, '..', 'out', 'previews');
await mkdir(out, { recursive: true });
for (const [name, email] of Object.entries(emails)) {
  await writeFile(path.join(out, `${name}.html`), wrapEmail(email.bodyHtml));
  await writeFile(path.join(out, `${name}.txt`), `Subject: ${email.subject}\n\n${email.text}`);
}
console.log(`Wrote ${Object.keys(emails).length} previews to ${out}`);
