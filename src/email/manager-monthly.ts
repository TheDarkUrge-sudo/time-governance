/** Week 2 of the month: one utilization report per manager, covering their staff. */
import { monthLabel } from '../calendar';
import type { UtilizationRow } from '../checks/utilization';
import { escapeHtml, hours, percent } from '../format';
import { type EmailContent, FONT, heading, MUTED, paragraph, table, textFooter } from './layout';

export function renderManagerMonthly(opts: {
  /** YYYY-MM */
  month: string;
  managerName: string | null;
  rows: UtilizationRow[];
}): EmailContent {
  const label = monthLabel(opts.month);
  const subject = `${label} utilization report`;
  const to = opts.managerName ? `To: ${opts.managerName}` : 'To: Manager';

  let html = heading(`${label} utilization report`, `${to}  |  prior-month time, as confirmed`);
  const util = (r: UtilizationRow) => {
    if (r.utilization === null) return '—';
    const color = r.target === null ? '#333333' : r.underTarget ? '#B71C1C' : '#2E7D32';
    return `<span style="font-weight:bold;color:${color};">${percent(r.utilization)}</span>`;
  };
  const flaggedCapacity = opts.rows.some((r) => r.capacitySource !== 'karbon');
  html += `<div style="overflow-x:auto;">${table(
    [
      { label: 'Staff' },
      { label: 'Department' },
      { label: 'Billable', align: 'right' },
      { label: 'Non-bill.', align: 'right' },
      { label: 'PTO', align: 'right' },
      { label: 'Sick', align: 'right' },
      { label: 'Capacity', align: 'right' },
      { label: 'Util. %', align: 'right' },
      { label: 'Target', align: 'right' },
    ],
    opts.rows.map((r) => [
      escapeHtml(r.member.name),
      `<span style="color:${MUTED};">${escapeHtml(r.member.department)}</span>`,
      `${hours(r.minutes.billable)}h`,
      `${hours(r.minutes.nonBillable)}h`,
      `${hours(r.minutes.pto)}h`,
      `${hours(r.minutes.sick)}h`,
      `${hours(r.capacityMinutes)}h${r.capacitySource === 'karbon' ? '' : '*'}`,
      util(r),
      `<span style="color:${MUTED};">${r.target === null ? '—' : percent(r.target)}</span>`,
    ]),
  )}</div>`;

  const under = opts.rows.filter(
    (r) => r.underTarget && r.utilization !== null && r.target !== null,
  );
  const summary =
    under.length === 0
      ? 'Everyone with a target is at or above it.'
      : under
          .map(
            (r) =>
              `${r.member.name} is ${Math.round((r.target! - r.utilization!) * 100)} points under target.`,
          )
          .join(' ') + ' Worth a look before it becomes a pattern.';
  html += paragraph(escapeHtml(summary), { muted: true });
  if (flaggedCapacity) {
    html += `<p style="${FONT};color:${MUTED};font-size:11px;margin:8px 0 0;">* Karbon has no capacity set for this person, so capacity uses the roster's expected weekly hours (or a full-time week).</p>`;
  }

  const text = [
    `${label} utilization report`,
    '',
    ...opts.rows.map(
      (r) =>
        `- ${r.member.name} (${r.member.department}): billable ${hours(r.minutes.billable)}h, non-billable ${hours(r.minutes.nonBillable)}h, PTO ${hours(r.minutes.pto)}h, sick ${hours(r.minutes.sick)}h, capacity ${hours(r.capacityMinutes)}h, utilization ${r.utilization === null ? '—' : percent(r.utilization)} (target ${r.target === null ? '—' : percent(r.target)})`,
    ),
    '',
    summary,
  ];
  return { subject, bodyHtml: html, text: text.join('\n') + textFooter() };
}
