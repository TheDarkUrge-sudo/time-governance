/** Week 2 of the month: last month's utilization, one email per manager. */
import { monthLabel, monthRange } from '../calendar';
import { runUtilization, type UtilizationRow } from '../checks/utilization';
import { usersByEmail } from '../checks/weekly';
import { renderManagerMonthly } from '../email/manager-monthly';
import { finishWithAdminSummary, type JobDeps, type JobResult, recordRun } from './context';
import { deliver, type DeliveryResult } from './deliver';

const CAPACITY_CONCURRENCY = 4;

export async function runMonthly(deps: JobDeps, month: string): Promise<JobResult> {
  return recordRun(deps, 'monthly', month, async () => {
    const range = monthRange(month);
    const [users, entries] = await Promise.all([
      deps.karbon.listUsers(),
      deps.karbon.listTimeEntries(range),
    ]);

    // Capacity is per user (GET /v3/Users/{id}); only fetch it for roster staff.
    const byEmail = usersByEmail(users);
    const ids = deps.roster.members
      .filter((m) => m.active && !m.excluded)
      .map((m) => byEmail.get(m.email)?.id)
      .filter((id): id is string => Boolean(id));
    const capacity = new Map<string, number | null>();
    for (let i = 0; i < ids.length; i += CAPACITY_CONCURRENCY) {
      const batch = ids.slice(i, i + CAPACITY_CONCURRENCY);
      const values = await Promise.all(batch.map((id) => deps.karbon.getUserCapacityMinutes(id)));
      batch.forEach((id, j) => capacity.set(id, values[j] ?? null));
    }

    const report = runUtilization({
      month: range,
      roster: deps.roster,
      users,
      entries,
      capacityMinutesPerWeek: capacity,
      policy: deps.policy,
    });

    const byManager = new Map<string, UtilizationRow[]>();
    const noManager: UtilizationRow[] = [];
    for (const row of report.rows) {
      const email = row.member.managerEmail;
      if (!email) {
        noManager.push(row);
        continue;
      }
      byManager.set(email, [...(byManager.get(email) ?? []), row]);
    }

    const deliveries: DeliveryResult[] = [];
    for (const [email, rows] of byManager) {
      deliveries.push(
        await deliver(deps.delivery, {
          kind: 'manager_monthly',
          period: month,
          recipientKey: `manager:${email}`,
          to: [email],
          content: renderManagerMonthly({
            month,
            managerName: rows[0]!.member.managerName,
            rows,
          }),
        }),
      );
    }

    const sections = [
      {
        title: 'Not in any report — no Manager Email on the roster',
        lines: noManager.map((r) => r.member.name),
      },
      {
        title: 'Not measured — no Karbon user has this roster email',
        lines: report.unmatched.map((m) => `${m.name} <${m.email}>`),
      },
      {
        title: 'Capacity not set in Karbon (used roster hours or a full-time week)',
        lines: report.rows.filter((r) => r.capacitySource !== 'karbon').map((r) => r.member.name),
      },
    ];
    const all = await finishWithAdminSummary(
      deps,
      {
        job: 'monthly',
        period: month,
        title: `Monthly utilization run: ${monthLabel(month)}`,
        sub: `${report.rows.length} people · ${byManager.size} managers`,
        sections,
      },
      deliveries,
    );
    return {
      period: month,
      deliveries: all,
      admin: sections,
      summary: {
        people: report.rows.length,
        managers: byManager.size,
        underTarget: report.rows.filter((r) => r.underTarget).length,
        emails: all.map((d) => `${d.kind}:${d.recipientKey}:${d.outcome}`),
      },
    };
  });
}
