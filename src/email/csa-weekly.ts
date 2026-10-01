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

function entryLines(f: Flag): string[] {
  const list = f.entries ?? [];
  const lines = list.slice(0, MAX_ENTRIES).map((e) => entryLine(f.kind, e));
  if (list.length > MAX_ENTRIES) {
    const more = list.length - MAX_ENTRIES;
    lines.push(`+${more} more ${more === 1 ? 'entry' : 'entries'}`);
  }
  return lines;
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
        escapeHtml(p.member.name),
        `<span style="color:${MUTED};">${escapeHtml(p.member.department)}</span>`,
        `${pill(FLAG_LABELS[f.kind], TONE[f.kind])}<div style="color:${MUTED};font-size:11px;margin-top:4px;">${escapeHtml(f.detail)}</div>${entryLines(
          f,
        )
          .map(
            (l) =>
              `<div style="color:#888888;font-size:11px;margin-top:2px;padding-left:8px;border-left:2px solid #E5E5E5;">${escapeHtml(l)}</div>`,
          )
          .join('')}`,
        hours(MISSING_KINDS.has(f.kind) ? p.minutes.total : f.minutes),
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
