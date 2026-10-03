/** The admin alert for a scheduled run with no successful record (src/jobs/watchdog.ts). */
import { dayLabel, monthLabel, shortDate } from '../calendar';
import { escapeHtml } from '../format';
import type { MissedRun } from '../jobs/watchdog';
import { type EmailContent, FONT, heading, paragraph, textFooter } from './layout';

const NAMES = {
  tuesday: 'Tuesday review',
  friday: 'Friday escalation',
  monthly: 'monthly utilization report',
} as const;

export function renderMissedRun(m: MissedRun): EmailContent {
  const what =
    m.job === 'monthly'
      ? `${NAMES.monthly}, ${monthLabel(m.period)}`
      : `${NAMES[m.job]}, week of ${shortDate(m.period)}`;
  const command =
    m.job === 'monthly'
      ? `pnpm tg run monthly --month ${m.period}`
      : `pnpm tg run ${m.job} --week ${m.period}`;
  const why =
    m.last === null
      ? 'There is no record of it running. The worker was probably down or restarting at 9:00, or the run failed before it started (Karbon or the database unreachable, or a setting missing) — the worker log has the reason.'
      : m.last.status === 'failed'
        ? `It started but failed: ${m.last.error ?? 'no error recorded'}.`
        : 'It started but never finished — the worker probably stopped mid-run. Some emails may already have gone out; re-running sends only the rest.';
  const subject = `Missed run: ${what}`;
  const steps = [
    `Run it now where the worker runs — the Replit Shell, or \`az containerapp exec\` on Azure (not a laptop set to TG_MODE=off, which sends nothing): ${command}`,
    'Re-running is safe: anything already sent is skipped.',
    'If the worker was not deployed yet when this run was due, ignore this email.',
  ];

  let html = heading(subject, `Scheduled ${dayLabel(m.scheduledOn)}, 9:00  |  To: Admin`);
  html += paragraph(escapeHtml(why));
  html += paragraph(
    `Run it now where the worker runs — the Replit Shell, or <code>az containerapp exec</code> on Azure (not a laptop set to <code>TG_MODE=off</code>, which sends nothing):`,
  );
  html += `<p style="${FONT};font-size:13px;margin:8px 0 0;"><code style="background-color:#F5F5F5;border:1px solid #E5E5E5;border-radius:4px;padding:4px 8px;">${escapeHtml(command)}</code></p>`;
  html += paragraph(escapeHtml(steps.slice(1).join(' ')), { muted: true });

  const text = [subject, '', why, '', ...steps].join('\n');
  return { subject, bodyHtml: html, text: text + textFooter() };
}
