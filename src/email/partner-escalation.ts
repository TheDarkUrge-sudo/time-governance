/** Friday: one email to the Partners listing anyone still missing time. */
import { addDays, shortDate } from '../calendar';
import type { EscalationRow } from '../checks/escalation';
import { FLAG_LABELS } from '../checks/weekly';
import type { DateRange } from '../domain';
import { escapeHtml } from '../format';
import { type EmailContent, heading, MUTED, paragraph, pill, table, textFooter } from './layout';

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
      r.weeksFlagged >= 2
        ? pill(`${r.weeksFlagged} of last ${lookbackWeeks}`, 'red')
        : String(r.weeksFlagged),
    ]),
  );

  const repeat = rows.filter((r) => r.weeksFlagged >= 2);
  const text: string[] = [
    `Time entry still outstanding: week of ${weekLabel}`,
    '',
    'CSAs followed up on Tuesday. These employees still have not entered their time for the week:',
    ...rows.map(
      (r) =>
        `- ${r.member.name} (${r.member.department}; manager ${r.member.managerName ?? '—'}): ${FLAG_LABELS[r.kind]}, flagged ${r.weeksFlagged} of the last ${lookbackWeeks} weeks`,
    ),
  ];

  if (repeat.length > 0) {
    const lines = repeat.map(
      (r) =>
        `${r.member.name} has now been flagged ${r.weeksFlagged} of the last ${lookbackWeeks} weeks.`,
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
