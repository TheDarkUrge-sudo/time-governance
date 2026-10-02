/** Tuesday: one email per CSA, covering only the staff assigned to their slot. */
import { dayLabel, shortDate } from '../calendar';
import {
  type Flag,
  FLAG_LABELS,
  type FlagEntry,
  type FlagKind,
  MISSING_KINDS,
  type PersonWeek,
} from '../checks/weekly';
import type { DateRange, RosterMember } from '../domain';
import { escapeHtml, hours } from '../format';
import { timesheetUrl } from '../karbon/links';
import { actionButton, type Draft, firstName, greeting, linkButton, signOff } from './actions';
import {
  type EmailContent,
  heading,
  MUTED,
  paragraph,
  pill,
  type PillTone,
  sectionLabel,
  table,
  textFooter,
  tiles,
} from './layout';

const CHECK_ORDER: FlagKind[] = [
  'no_entry',
  'minimal_entry',
  'internal_client_billable',
  'internal_only_role',
  'nonbillable_unexplained',
  'ad_hoc_work',
];

/** Entries shown under one flag; the rest are summarized as "+N more". */
const MAX_ENTRIES = 5;

/** "Tue Sep 22 · Acme Manufacturing · 2.0 h · Admin · “call”" */
function entryLine(kind: FlagKind, e: FlagEntry): string {
  const parts = [dayLabel(e.date), e.client, `${hours(e.minutes)} h`];
  if (e.taskType) parts.push(e.taskType);
  if (kind === 'internal_only_role' && e.role) parts.push(e.role);
  if (kind === 'nonbillable_unexplained' || kind === 'ad_hoc_work') {
    parts.push(e.description ? `“${e.description}”` : '(no description)');
  }
  return parts.join(' · ');
}

export function entryLines(f: Flag): string[] {
  const list = f.entries ?? [];
  const lines = list.slice(0, MAX_ENTRIES).map((e) => entryLine(f.kind, e));
  if (list.length > MAX_ENTRIES) {
    const more = list.length - MAX_ENTRIES;
    lines.push(`+${more} more ${more === 1 ? 'entry' : 'entries'}`);
  }
  return lines;
}

/** What the employee is asked to do about each indicator flag, in the draft. */
const ASK: Partial<Record<FlagKind, string>> = {
  internal_client_billable:
    'Billable time on the internal HFA client — it should be a non-billable task type, or moved to the client it was for:',
  internal_only_role: 'An internal-only role on client work — please change the role:',
  nonbillable_unexplained:
    'Non-billable client time without a clear description — please add what the time was for:',
  ad_hoc_work:
    "Time on a client's Ad Hoc work item — if it belongs to a specific engagement, please move it there:",
};

/**
 * One draft per person covering all their flags this week: missing time first
 * (enter it by Thursday, before Friday's escalation), then the entries to fix.
 */
export function csaDraft(opts: {
  week: DateRange;
  csaName: string | null;
  person: PersonWeek;
  /** "Open timesheet" address for this person's week, when links are set up. */
  timesheetUrl?: string | null;
}): Draft {
  const { person } = opts;
  const weekLabel = shortDate(opts.week.start);
  const asks: string[] = [];
  const details: string[] = [];
  for (const f of person.flags) {
    if (f.kind === 'no_entry') {
      asks.push(
        `I don't see your time for the week of ${weekLabel} in Karbon. Can you enter it by Thursday?`,
      );
    } else if (f.kind === 'minimal_entry') {
      // f.minutes is worked time — what the flag measured; PTO and sick are on top.
      const leave = person.minutes.pto + person.minutes.sick;
      asks.push(
        `I only see ${hours(f.minutes)} hours of work for the week of ${weekLabel} in Karbon${leave > 0 ? ` (plus ${hours(leave)} hours of PTO/sick)` : ''}. Can you enter the rest by Thursday?`,
      );
    }
  }
  const indicators = person.flags.filter((f) => !MISSING_KINDS.has(f.kind));
  if (indicators.length > 0) {
    asks.push(
      `${asks.length > 0 ? 'Also, a' : 'A'} few of your time entries for the week of ${weekLabel} need a fix in Karbon:`,
    );
    for (const f of indicators) {
      if (details.length > 0) details.push('');
      details.push(ASK[f.kind] ?? FLAG_LABELS[f.kind]);
      for (const e of f.entries ?? []) details.push(`- ${entryLine(f.kind, e)}`);
    }
  }
  return {
    to: [person.member.email],
    subject: `Time entry: week of ${weekLabel}`,
    opening: [
      greeting(person.member.name),
      '',
      ...asks,
      ...(opts.timesheetUrl ? ['', `Your timesheet for that week: ${opts.timesheetUrl}`] : []),
    ].join('\n'),
    details,
    closing: signOff(opts.csaName),
  };
}

const TONE: Record<FlagKind, PillTone> = {
  no_entry: 'red',
  minimal_entry: 'amber',
  internal_client_billable: 'blue',
  internal_only_role: 'blue',
  nonbillable_unexplained: 'blue',
  ad_hoc_work: 'blue',
};

export function renderCsaWeekly(opts: {
  week: DateRange;
  csaName: string | null;
  people: PersonWeek[];
  /** Assigned to this CSA but with no Karbon user at their email. */
  unmatched: RosterMember[];
  /** KARBON_TIMESHEET_URL; null or absent = no "Open timesheet" links. */
  timesheetUrlTemplate?: string | null;
}): EmailContent {
  const { week, people } = opts;
  const weekLabel = shortDate(week.start);
  // Check order first (no entry, minimal, then the four checks), then name.
  const flagged = people
    .flatMap((p) => p.flags.map((f) => ({ p, f })))
    .sort(
      (a, b) =>
        CHECK_ORDER.indexOf(a.f.kind) - CHECK_ORDER.indexOf(b.f.kind) ||
        a.p.member.name.localeCompare(b.p.member.name),
    );
  const count = (pred: (k: FlagKind) => boolean) => flagged.filter(({ f }) => pred(f.kind)).length;
  const noEntry = count((k) => k === 'no_entry');
  const minimal = count((k) => k === 'minimal_entry');
  const indicators = count((k) => !MISSING_KINDS.has(k));

  const subject =
    flagged.length === 0
      ? `Weekly time entry review: week of ${weekLabel} — no flags`
      : `Weekly time entry review: week of ${weekLabel} — ${flagged.length} ${flagged.length === 1 ? 'flag' : 'flags'}`;
  const to = opts.csaName ? `To: ${opts.csaName}` : 'To: CSA Team';
  const range = `${shortDate(week.start)} – ${shortDate(week.end)}`;

  const linkFor = (p: PersonWeek) =>
    timesheetUrl(opts.timesheetUrlTemplate ?? null, p.timesheetKey);
  const personButtons = (p: PersonWeek) => {
    const url = linkFor(p);
    return (
      actionButton(
        `Email ${firstName(p.member.name) ?? 'them'}`,
        csaDraft({ week, csaName: opts.csaName, person: p, timesheetUrl: url }),
      ) + (url ? linkButton('Open timesheet', url) : '')
    );
  };

  let html = heading(`Weekly time entry review: week of ${weekLabel}`, `${to}  |  ${range}`);
  html += tiles([
    { label: 'No time logged', value: noEntry, alert: true },
    { label: 'Minimal entries', value: minimal },
    { label: 'Indicator flags', value: indicators },
  ]);

  const text: string[] = [`Weekly time entry review: week of ${weekLabel} (${range})`, ''];
  text.push(
    `No time logged: ${noEntry}   Minimal entries: ${minimal}   Indicator flags: ${indicators}`,
    '',
  );

  if (flagged.length === 0) {
    html += paragraph(
      `No flags this week: everyone assigned to you logged time, and none of the four checks found misrouted time.`,
    );
    text.push('No flags this week.');
  } else {
    html += sectionLabel('Flagged this week');
    html += table(
      [
        { label: 'Employee' },
        { label: 'Department' },
        { label: 'Check failed' },
        { label: 'Hours', align: 'right' },
      ],
      flagged.map(({ p, f }) => [
        // Every row of a person opens the same draft, covering all their flags.
        `${escapeHtml(p.member.name)}<br/>${personButtons(p)}`,
        `<span style="color:${MUTED};">${escapeHtml(p.member.department)}</span>`,
        `${pill(FLAG_LABELS[f.kind], TONE[f.kind])}<div style="color:${MUTED};font-size:11px;margin-top:4px;">${escapeHtml(f.detail)}</div>${entryLines(
          f,
        )
          .map(
            (l) =>
              `<div style="color:#888888;font-size:11px;margin-top:2px;padding-left:8px;border-left:2px solid #E5E5E5;">${escapeHtml(l)}</div>`,
          )
          .join('')}`,
        // The minutes the flag measured: worked time for missing/minimal, the flagged time otherwise.
        hours(f.minutes),
      ]),
    );
    html += paragraph(
      'Follow up directly with each flagged employee today. Anyone still missing time by Friday will be escalated to the Partners.',
    );
    text.push('Flagged this week:');
    for (const { p, f } of flagged) {
      text.push(
        `- ${p.member.name} (${p.member.department}): ${FLAG_LABELS[f.kind]} — ${f.detail}`,
      );
      for (const l of entryLines(f)) text.push(`    ${l}`);
    }
    text.push(
      '',
      'Follow up directly with each flagged employee today. Anyone still missing time by Friday will be escalated to the Partners.',
    );
  }

  if (opts.unmatched.length > 0) {
    const names = opts.unmatched.map((m) => `${m.name} (${m.email})`).join(', ');
    html += paragraph(
      `Not checked — no Karbon user has these emails: ${escapeHtml(names)}. Fix the email on the roster or in Karbon.`,
      { muted: true },
    );
    text.push('', `Not checked — no Karbon user has these emails: ${names}.`);
  }

  return { subject, bodyHtml: html, text: text.join('\n') + textFooter() };
}
