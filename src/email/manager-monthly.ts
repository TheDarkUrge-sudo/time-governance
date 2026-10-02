/** Week 2 of the month: one utilization report per manager, covering their staff. */
import { monthLabel, monthName, shortMonth } from '../calendar';
import { trendPoints, type UtilizationRow } from '../checks/utilization';
import { escapeHtml, hours, percent } from '../format';
import { actionButton, type Draft, firstName, greeting, signOff } from './actions';
import { type EmailContent, FONT, heading, MUTED, paragraph, table, textFooter } from './layout';

/** "▲ 4", "▼ 8", "±0", or "—" when there is nothing to compare. */
function trendLabel(points: number | null): string {
  if (points === null) return '—';
  if (points > 0) return `▲ ${points}`;
  if (points < 0) return `▼ ${-points}`;
  return '±0';
}

/** "down 9 from August", "up 3 from August", "level with August". */
function trendPhrase(points: number | null, month: string): string | null {
  if (points === null) return null;
  if (points === 0) return `level with ${monthName(month)}`;
  return `${points > 0 ? 'up' : 'down'} ${Math.abs(points)} from ${monthName(month)}`;
}

const plural = (n: number) => (n === 1 ? 'point' : 'points');

/** Changes smaller than this stay grey in the trend column. */
const NOTABLE_POINTS = 5;

/** Under target, or at target but down `dropPoints` or more — the people the summary names. */
function calledOut(r: UtilizationRow, dropPoints: number): boolean {
  if (r.underTarget && r.utilization !== null && r.target !== null) return true;
  const points = trendPoints(r);
  return points !== null && points <= -dropPoints;
}

/** The manager's note to someone the report calls out: the numbers, then an offer to talk. */
export function managerStaffDraft(opts: {
  month: string;
  previousMonth: string;
  managerName: string | null;
  row: UtilizationRow;
}): Draft {
  const { row: r } = opts;
  const phrase = trendPhrase(trendPoints(r), opts.previousMonth);
  const util = r.utilization === null ? '—' : percent(r.utilization);
  const vsTarget =
    r.target === null
      ? ''
      : r.underTarget
        ? ` against a target of ${percent(r.target)}`
        : ` (target ${percent(r.target)})`;
  return {
    to: [r.member.email],
    subject: `${monthName(opts.month)} utilization`,
    opening: [
      greeting(r.member.name),
      '',
      `Your billable utilization for ${monthName(opts.month)} was ${util}${vsTarget}${phrase ? `, ${phrase}` : ''}. Can we find 15 minutes this week to look at your workload and what's coming up?`,
    ].join('\n'),
    closing: signOff(opts.managerName),
  };
}

export function renderManagerMonthly(opts: {
  /** YYYY-MM */
  month: string;
  /** YYYY-MM — the month the trend compares against. */
  previousMonth: string;
  managerName: string | null;
  rows: UtilizationRow[];
  /** A drop at least this large is called out even when the person is at target. */
  dropPoints: number;
}): EmailContent {
  const label = monthLabel(opts.month);
  const prev = opts.previousMonth;
  const subject = `${label} utilization report`;
  const to = opts.managerName ? `To: ${opts.managerName}` : 'To: Manager';

  let html = heading(`${label} utilization report`, `${to}  |  prior-month time, as confirmed`);
  const util = (r: UtilizationRow) => {
    if (r.utilization === null) return '—';
    const color = r.target === null ? '#333333' : r.underTarget ? '#B71C1C' : '#2E7D32';
    return `<span style="font-weight:bold;color:${color};">${percent(r.utilization)}</span>`;
  };
  const trend = (r: UtilizationRow) => {
    const points = trendPoints(r);
    // Color only a real move; a point or two either way is noise.
    const color =
      points === null || Math.abs(points) < NOTABLE_POINTS
        ? MUTED
        : points < 0
          ? '#B71C1C'
          : '#2E7D32';
    const title =
      r.previousUtilization == null
        ? ''
        : ` title="${shortMonth(prev)}: ${percent(r.previousUtilization)}"`;
    return `<span style="color:${color};white-space:nowrap;"${title}>${trendLabel(points)}</span>`;
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
      { label: `vs. ${shortMonth(prev)}`, align: 'right' },
      { label: 'Target', align: 'right' },
    ],
    opts.rows.map((r) => [
      `<span style="white-space:nowrap;">${escapeHtml(r.member.name)}</span>${
        calledOut(r, opts.dropPoints)
          ? `<br/>${actionButton(
              `Email ${firstName(r.member.name) ?? 'them'}`,
              managerStaffDraft({
                month: opts.month,
                previousMonth: prev,
                managerName: opts.managerName,
                row: r,
              }),
            )}`
          : ''
      }`,
      `<span style="color:${MUTED};">${escapeHtml(r.member.department)}</span>`,
      `${hours(r.minutes.billable)}h`,
      `${hours(r.minutes.nonBillable)}h`,
      `${hours(r.minutes.pto)}h`,
      `${hours(r.minutes.sick)}h`,
      `${hours(r.capacityMinutes)}h${r.capacitySource === 'karbon' ? '' : '*'}`,
      util(r),
      trend(r),
      `<span style="color:${MUTED};">${r.target === null ? '—' : percent(r.target)}</span>`,
    ]),
  )}</div>`;

  // Under target first (with the trend), then anyone at target who fell sharply.
  const lines: string[] = [];
  for (const r of opts.rows) {
    const points = trendPoints(r);
    const phrase = trendPhrase(points, prev);
    if (r.underTarget && r.utilization !== null && r.target !== null) {
      const gap = Math.round(r.target * 100) - Math.round(r.utilization * 100);
      const head =
        gap < 1
          ? `${r.member.name} is just under target`
          : `${r.member.name} is ${gap} ${plural(gap)} under target`;
      lines.push(`${head}${phrase ? `, ${phrase}` : ''}.`);
    } else if (points !== null && points <= -opts.dropPoints) {
      lines.push(
        `${r.member.name} dropped ${-points} ${plural(-points)} from ${monthName(prev)}${r.target !== null ? ', though still at target' : ''}.`,
      );
    }
  }
  const summary =
    lines.length === 0
      ? 'Everyone with a target is at or above it, with no sharp drops.'
      : `${lines.join(' ')} Worth a look before it becomes a pattern.`;
  html += paragraph(escapeHtml(summary), { muted: true });
  if (flaggedCapacity) {
    html += `<p style="${FONT};color:${MUTED};font-size:11px;margin:8px 0 0;">* Karbon has no capacity set for this person, so capacity uses the roster's expected weekly hours (or a full-time week).</p>`;
  }

  const text = [
    `${label} utilization report`,
    '',
    ...opts.rows.map((r) => {
      const points = trendPoints(r);
      const vs =
        r.previousUtilization == null
          ? ''
          : `, vs ${shortMonth(prev)} ${percent(r.previousUtilization)} ${trendLabel(points)}`;
      return `- ${r.member.name} (${r.member.department}): billable ${hours(r.minutes.billable)}h, non-billable ${hours(r.minutes.nonBillable)}h, PTO ${hours(r.minutes.pto)}h, sick ${hours(r.minutes.sick)}h, capacity ${hours(r.capacityMinutes)}h, utilization ${r.utilization === null ? '—' : percent(r.utilization)} (target ${r.target === null ? '—' : percent(r.target)})${vs}`;
    }),
    '',
    summary,
  ];
  return { subject, bodyHtml: html, text: text.join('\n') + textFooter() };
}
