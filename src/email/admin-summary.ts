/**
 * After every run, a short summary to TG_ADMIN_TO: what went to whom, and the
 * roster hygiene a person needs to fix (unmatched emails, unrouted staff,
 * task types missing from the workbook, Karbon users logging time who are not
 * on the roster). Keeps the CSA, Partner and Manager emails about people only.
 */
import { escapeHtml, hours } from '../format';
import { type EmailContent, heading, paragraph, sectionLabel, textFooter } from './layout';

export interface AdminSection {
  title: string;
  lines: string[];
}

export function renderAdminSummary(opts: {
  title: string;
  sub: string;
  sections: AdminSection[];
}): EmailContent {
  let html = heading(opts.title, opts.sub);
  const text: string[] = [opts.title, opts.sub];
  const nonEmpty = opts.sections.filter((s) => s.lines.length > 0);
  for (const s of nonEmpty) {
    html += sectionLabel(s.title);
    html += `<ul style="font-family:Arial,Helvetica,sans-serif;color:#333333;font-size:12px;line-height:1.6;margin:0 0 16px;padding-left:18px;">${s.lines
      .map((l) => `<li>${escapeHtml(l)}</li>`)
      .join('')}</ul>`;
    text.push('', `${s.title}:`, ...s.lines.map((l) => `- ${l}`));
  }
  if (nonEmpty.length === 0) {
    html += paragraph('Nothing to report.');
    text.push('', 'Nothing to report.');
  }
  return { subject: opts.title, bodyHtml: html, text: text.join('\n') + textFooter() };
}

export const unclassifiedLine = (t: { name: string; minutes: number; entries: number }) =>
  `${t.name}: ${hours(t.minutes)} h across ${t.entries} ${t.entries === 1 ? 'entry' : 'entries'}`;
