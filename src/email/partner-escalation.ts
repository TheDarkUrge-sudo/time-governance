/** Friday: one email to the Partners listing anyone still missing time. */
import { addDays, shortDate } from '../calendar';
import type { EscalationRow } from '../checks/escalation';
import { FLAG_LABELS } from '../checks/weekly';
import type { DateRange } from '../domain';
import { escapeHtml } from '../format';
import { commentText } from '../karbon/governance-notes';
import {
  type EmailContent,
  heading,
  MUTED,
  paragraph,
  pill,
  sectionLabel as sectionLabelHtml,
  table,
  textFooter,
} from './layout';

/** Escalated this many times in a calendar year counts as a pattern, even if not recent. */
const YEAR_PATTERN = 3;

export function renderPartnerEscalation(opts: {
  week: DateRange;
  rows: EscalationRow[];
  /** The first week with stored escalation history (for the "counts are partial" note). */
  historyStartsWeek: string | null;
  lookbackWeeks: number;
}): EmailContent {
  const { week, rows, lookbackWeeks } = opts;
  const weekLabel = shortDate(week.start);
  const subject = `Time entry still outstanding: week of ${weekLabel} — ${rows.length} ${rows.length === 1 ? 'person' : 'people'}`;

  let html = heading(
    `Time entry still outstanding: week of ${weekLabel}`,
    'To: Partners  |  Friday',
  );
  html += `<p style="font-family:Arial,Helvetica,sans-serif;color:#333333;font-size:14px;line-height:1.6;margin:0 0 16px;">CSAs followed up on Tuesday. These employees still have not entered their time for the week.</p>`;
  html += table(
    [
      { label: 'Employee' },
      { label: 'Department' },
      { label: 'Manager' },
      { label: 'Still missing' },
      { label: 'Weeks flagged', align: 'right' },
    ],
    rows.map((r) => [
      escapeHtml(r.member.name),
      `<span style="color:${MUTED};">${escapeHtml(r.member.department)}</span>`,
      `<span style="color:${MUTED};">${escapeHtml(r.member.managerName ?? '—')}</span>`,
      `<span style="color:${MUTED};">${escapeHtml(FLAG_LABELS[r.kind])}</span>`,
      (r.weeksFlagged >= 2
        ? pill(`${r.weeksFlagged} of last ${lookbackWeeks}`, 'red')
        : String(r.weeksFlagged)) +
        (r.thisYear > r.weeksFlagged
          ? `<div style="color:${MUTED};font-size:11px;margin-top:4px;white-space:nowrap;">${r.thisYear} this year</div>`
          : ''),
    ]),
  );

  // A repeat is either recent (2+ of the last 4 weeks) or a pattern across the year.
  const repeat = rows.filter((r) => r.weeksFlagged >= 2 || r.thisYear >= YEAR_PATTERN);
  const yearNote = (r: EscalationRow) =>
    r.thisYear > r.weeksFlagged ? ` (${r.thisYear} this year)` : '';
  const text: string[] = [
    `Time entry still outstanding: week of ${weekLabel}`,
    '',
    'CSAs followed up on Tuesday. These employees still have not entered their time for the week:',
    ...rows.map(
      (r) =>
        `- ${r.member.name} (${r.member.department}; manager ${r.member.managerName ?? '—'}): ${FLAG_LABELS[r.kind]}, flagged ${r.weeksFlagged} of the last ${lookbackWeeks} weeks${yearNote(r)}`,
    ),
  ];

  const withFollowUp = rows.filter((r) => r.followUp && r.followUp.length > 0);
  if (withFollowUp.length > 0) {
    html += `<div style="height:16px"></div>${sectionLabelHtml('CSA follow-up (from Karbon)')}`;
    text.push('', 'CSA follow-up (from Karbon):');
    for (const r of withFollowUp) {
      for (const c of r.followUp!) {
        const who = [
          c.author?.split('@')[0],
          c.createdAt ? shortDate(c.createdAt.slice(0, 10)) : null,
        ]
          .filter(Boolean)
          .join(', ');
        const line = `${r.member.name}: “${commentText(c.body)}”${who ? ` (${who})` : ''}`;
        html += `<p style="font-family:Arial,Helvetica,sans-serif;color:#333333;font-size:12px;line-height:1.5;margin:0 0 6px;">${escapeHtml(line)}</p>`;
        text.push(`- ${line}`);
      }
    }
  }

  if (repeat.length > 0) {
    const lines = repeat.map((r) =>
      r.weeksFlagged >= 2
        ? `${r.member.name} has now been flagged ${r.weeksFlagged} of the last ${lookbackWeeks} weeks${yearNote(r)}.`
        : `${r.member.name} has been escalated ${r.thisYear} times this year.`,
    );
    const advice =
      'Repeat delinquency calls for a habit-correction conversation, not another reminder.';
    html += paragraph(`${lines.map(escapeHtml).join(' ')} ${advice}`, { muted: true });
    text.push('', ...lines, advice);
  } else {
    const advice = 'All first occurrences this week — a quick reminder is usually enough.';
    html += paragraph(advice, { muted: true });
    text.push('', advice);
  }

  if (opts.historyStartsWeek) {
    const full = addDays(opts.historyStartsWeek, 7 * (lookbackWeeks - 1));
    if (week.start < full) {
      const note = `Flag history starts the week of ${shortDate(opts.historyStartsWeek)}, so "weeks flagged" covers fewer than ${lookbackWeeks} weeks until the week of ${shortDate(full)}.`;
      html += paragraph(escapeHtml(note), { muted: true });
      text.push('', note);
    }
  }

  return { subject, bodyHtml: html, text: text.join('\n') + textFooter() };
}
