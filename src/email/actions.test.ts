import { describe, expect, it } from 'vitest';

import { employeeReviewNote } from '../karbon/note-bodies';
import { member } from '../test-fixtures';
import { actionButton, firstName, mailtoHref, MAX_MAILTO_LENGTH } from './actions';
import { csaDraft, renderCsaWeekly } from './csa-weekly';
import { managerStaffDraft } from './manager-monthly';
import { partnerEmployeeDraft, partnerManagerDraft } from './partner-escalation';

const week = { start: '2026-09-21', end: '2026-09-27' };
const none = { total: 0, billable: 0, nonBillable: 0, pto: 0, sick: 0, unclassified: 0 };

/** The draft a mailto link opens, decoded the way a mail client would. */
function open(href: string) {
  const [addr, query] = href.slice('mailto:'.length).split('?') as [string, string];
  const params = new URLSearchParams(query.replace(/\+/g, '%2B'));
  return {
    to: decodeURIComponent(addr),
    cc: params.get('cc'),
    subject: params.get('subject'),
    body: params.get('body'),
  };
}

describe('email actions', () => {
  it('encodes the draft so any mail client opens it intact', () => {
    const href = mailtoHref({
      to: ['jo.lee@hfacpas.com'],
      cc: ['dana+x@hfacpas.com'],
      subject: 'Time & billing: "week" of Sep 21?',
      opening: "Hi Jo,\n\nI don't see 50% done #1",
      closing: 'Thanks,',
    });
    expect(href).toMatch(/^mailto:jo\.lee@hfacpas\.com\?cc=dana%2Bx@hfacpas\.com&subject=/);
    expect(href).not.toMatch(/[ \n"#']/);
    expect(href).toContain('%0D%0A'); // CRLF line breaks (RFC 6068)
    const d = open(href);
    expect(d.subject).toBe('Time & billing: "week" of Sep 21?');
    expect(d.cc).toBe('dana+x@hfacpas.com');
    expect(d.body).toBe("Hi Jo,\r\n\r\nI don't see 50% done #1\r\n\r\nThanks,");
  });

  it('escapes the link for HTML and shortens drafts that would be too long', () => {
    const html = actionButton('Email <Jo>', {
      to: ['jo@hfacpas.com'],
      subject: 'a&b',
      opening: 'Hi',
      closing: 'Thanks,',
    });
    expect(html).toContain('?subject=a%26b&amp;body=');
    expect(html).toContain('Email &lt;Jo&gt;');

    const details = Array.from({ length: 60 }, (_, i) => `- Entry ${i} · Acme Corp · 1.0 h`);
    const href = mailtoHref({
      to: ['jo@hfacpas.com'],
      subject: 's',
      opening: 'Hi',
      details,
      closing: 'Thanks,\nTaylor',
    });
    expect(href.length).toBeLessThanOrEqual(MAX_MAILTO_LENGTH);
    const body = open(href).body!;
    expect(body).toMatch(/\(\+\d+ more — see Karbon\)\r\n\r\nThanks,\r\nTaylor$/);
    expect(body).toContain('- Entry 0 ·');
  });

  it('finds a first name either way round', () => {
    expect(firstName('Jordan Lee')).toBe('Jordan');
    expect(firstName('Lee, Jordan A.')).toBe('Jordan');
    expect(firstName('  ')).toBeNull();
  });

  it('CSA draft: one note per person — missing time by Thursday, then the entries to fix', () => {
    const d = csaDraft({
      week,
      csaName: 'Taylor Brooks',
      person: {
        member: member({ name: 'Jordan Lee' }),
        karbonUserId: 'k',
        minutes: { ...none, total: 390 },
        minimalThresholdMinutes: 1200,
        timesheetKey: null,
        flags: [
          { kind: 'minimal_entry', minutes: 390, detail: '6.5 h logged' },
          {
            kind: 'nonbillable_unexplained',
            minutes: 60,
            detail: '1 entry',
            entries: [
              {
                date: '2026-09-22',
                client: 'Acme Corp',
                minutes: 60,
                taskType: 'Admin',
                role: null,
                description: null,
              },
            ],
          },
        ],
      },
    });
    expect(d.to).toEqual(['jordan.lee@hfacpas.com']);
    expect(d.subject).toBe('Time entry: week of Sep 21');
    const body = open(mailtoHref(d)).body!.replace(/\r\n/g, '\n');
    expect(body).toBe(
      [
        'Hi Jordan,',
        '',
        'I only see 6.5 hours of work for the week of Sep 21 in Karbon. Can you enter the rest by Thursday?',
        'Also, a few of your time entries for the week of Sep 21 need a fix in Karbon:',
        '',
        'Non-billable client time without a clear description — please add what the time was for:',
        '- Tue Sep 22 · Acme Corp · 1.0 h · Admin · (no description)',
        '',
        'Thanks,',
        'Taylor',
      ].join('\n'),
    );
  });

  it('Partner drafts: a reminder the first time; a conversation, copying the manager, on a repeat', () => {
    const row = (weeksFlagged: number, thisYear: number) => ({
      member: member({ name: 'Riley Chen' }),
      kind: 'no_entry' as const,
      minutes: 0,
      weeksFlagged,
      lookbackWeeks: 4,
      thisYear,
    });
    const first = partnerEmployeeDraft(row(1, 1), week, 4);
    expect(first.cc).toBeUndefined();
    expect(first.opening).toContain("still isn't in Karbon. Please enter it today.");
    expect(first.closing).toBe('Thanks,');

    const repeat = partnerEmployeeDraft(row(3, 9), week, 4);
    expect(repeat.cc).toEqual(['dferris@hfacpas.com']);
    expect(repeat.opening).toContain('— flagged 3 of the last 4 weeks. Please enter it today');
    expect(repeat.opening).toContain("let's find 15 minutes");
    expect(partnerEmployeeDraft(row(1, 4), week, 4).opening).toContain(
      'escalated 4 times this year',
    );

    const mgr = partnerManagerDraft(row(3, 9), week, 4)!;
    expect(mgr.to).toEqual(['dferris@hfacpas.com']);
    expect(mgr.subject).toBe('Time entry: Riley Chen, week of Sep 21');
    expect(mgr.opening).toMatch(/^Hi Dana,\n\nRiley Chen's time .* Can you check in with Riley\?$/);
    const noManager = { ...row(1, 1), member: member({ name: 'Solo', managerEmail: null }) };
    expect(partnerManagerDraft(noManager, week, 4)).toBeNull();
  });

  it('Manager draft: the numbers, the trend and an offer to talk, signed by the manager', () => {
    const d = managerStaffDraft({
      month: '2026-09',
      previousMonth: '2026-08',
      managerName: 'Dana Ferris',
      row: {
        member: member({ name: 'Riley Chen' }),
        minutes: none,
        capacityMinutes: 6000,
        capacitySource: 'karbon',
        utilization: 0.62,
        previousUtilization: 0.71,
        target: 0.75,
        underTarget: true,
      },
    });
    expect(d.subject).toBe('September utilization');
    expect(d.opening).toContain(
      'Your billable utilization for September was 62% against a target of 75%, down 9 from August.',
    );
    expect(d.closing).toBe('Thanks,\nDana');
  });
});

describe('"Open timesheet" links', () => {
  const pattern = 'https://app2.karbonhq.com/AbCdEf123456/timesheet/{key}';
  const person = (timesheetKey: string | null) => ({
    member: member({ name: 'Jordan Lee' }),
    karbonUserId: 'k',
    minutes: { ...none, total: 390 },
    minimalThresholdMinutes: 1200,
    flags: [{ kind: 'minimal_entry' as const, minutes: 390, detail: '6.5 h logged' }],
    timesheetKey,
  });

  it('adds the button and puts the link in the draft, when set up', () => {
    const email = renderCsaWeekly({
      week,
      csaName: null,
      unmatched: [],
      people: [person('4bLnlnsHm4pM')],
      timesheetUrlTemplate: pattern,
    });
    expect(email.bodyHtml).toContain(
      'href="https://app2.karbonhq.com/AbCdEf123456/timesheet/4bLnlnsHm4pM"',
    );
    expect(email.bodyHtml).toContain('>Open timesheet</a>');
    const draft = csaDraft({
      week,
      csaName: null,
      person: person('4bLnlnsHm4pM'),
      timesheetUrl: 'https://app2.karbonhq.com/AbCdEf123456/timesheet/4bLnlnsHm4pM',
    });
    expect(draft.opening).toMatch(
      /by Thursday\?\n\nYour timesheet for that week: https:\/\/app2\.karbonhq\.com\/AbCdEf123456\/timesheet\/4bLnlnsHm4pM$/,
    );
    const note = employeeReviewNote(
      person('4bLnlnsHm4pM'),
      week,
      'https://app2.karbonhq.com/AbCdEf123456/timesheet/4bLnlnsHm4pM',
    );
    expect(note.bodyHtml).toContain('<p>Timesheet: <a href="https://app2.karbonhq.com/');
  });

  it('shows no button without a pattern or without a timesheet (no time logged)', () => {
    for (const [template, key] of [
      [null, '4bLnlnsHm4pM'],
      [pattern, null],
    ] as const) {
      const html = renderCsaWeekly({
        week,
        csaName: null,
        unmatched: [],
        people: [person(key)],
        timesheetUrlTemplate: template,
      }).bodyHtml;
      expect(html).not.toContain('Open timesheet');
      expect(html).not.toContain('karbonhq.com');
    }
  });
});

describe('draft details', () => {
  it('counts only entries in "+N more" and never ends on a bare heading', () => {
    const long = (i: number) => `- Tue Sep 22 · Client ${i} · 1.0 h · ${'x'.repeat(120)}`;
    const details = [
      'Billable time on the internal HFA client:',
      long(1),
      long(2),
      '',
      "Time on a client's Ad Hoc work item:",
      ...Array.from({ length: 12 }, (_, i) => long(10 + i)),
    ];
    const href = mailtoHref({
      to: ['jo@hfacpas.com'],
      subject: 's',
      opening: 'Hi',
      details,
      closing: 'Thanks,',
    });
    expect(href.length).toBeLessThanOrEqual(MAX_MAILTO_LENGTH);
    const body = open(href).body!.replace(/\r\n/g, '\n');
    const kept = (body.match(/^- /gm) ?? []).length;
    expect(body).toContain(`(+${14 - kept} more — see Karbon)`);
    const before = body.split('\n(+')[0]!.split('\n');
    expect(before[before.length - 1]).toMatch(/^- /);
  });

  it('a minimal-entry draft quotes worked hours, with PTO/sick on top', () => {
    const d = csaDraft({
      week,
      csaName: null,
      person: {
        member: member({ name: 'Jordan Lee' }),
        karbonUserId: 'k',
        minutes: { ...none, total: 1080, pto: 960 },
        minimalThresholdMinutes: 720,
        flags: [{ kind: 'minimal_entry', minutes: 120, detail: '2.0 h logged' }],
        timesheetKey: null,
      },
    });
    expect(d.opening).toContain(
      'I only see 2.0 hours of work for the week of Sep 21 in Karbon (plus 16.0 hours of PTO/sick).',
    );
  });
});
