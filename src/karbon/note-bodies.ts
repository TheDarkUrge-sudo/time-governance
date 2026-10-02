/** The per-employee Tuesday note. Summary notes reuse the email text (textToNoteHtml). */
import { addDays, shortDate } from '../calendar';
import { FLAG_LABELS, MISSING_KINDS, type PersonWeek } from '../checks/weekly';
import type { DateRange } from '../domain';
import { entryLines } from '../email/csa-weekly';
import { escapeHtml, hours } from '../format';

/** Tuesday's notes are due the Friday of the same week — the escalation day. */
export function reviewDueDate(week: DateRange): string {
  return addDays(week.end, 5);
}

export function employeeReviewNote(
  p: PersonWeek,
  week: DateRange,
): { subject: string; bodyHtml: string } {
  const subject = `Time review: ${p.member.name} — week of ${shortDate(week.start)}`;
  const items = p.flags
    .map((f) => {
      const entries = entryLines(f);
      return `<li><strong>${escapeHtml(FLAG_LABELS[f.kind])}</strong> — ${escapeHtml(f.detail)}${
        entries.length ? `<ul>${entries.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : ''
      }</li>`;
    })
    .join('');
  const missing = p.flags.some((f) => MISSING_KINDS.has(f.kind));
  const ask = missing
    ? 'Follow up this week and add a comment with what you hear. If they are still missing time on Friday they are escalated to the Partners, and your latest comment goes with them.'
    : 'Follow up and add a comment with the outcome (for example, “moved to the 2026 tax return job”).';
  const bodyHtml = `<p><strong>${escapeHtml(p.member.name)}</strong> (${escapeHtml(p.member.department)}) · ${shortDate(week.start)} – ${shortDate(week.end)} · ${hours(p.minutes.total)} h logged</p><ul>${items}</ul><p>${escapeHtml(ask)}</p>`;
  return { subject, bodyHtml };
}
