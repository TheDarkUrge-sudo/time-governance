/** Friday: re-check last week; escalate anyone Tuesday flagged who is still missing time. */
import { shortDate } from '../calendar';
import { escalations } from '../checks/escalation';
import { MISSING_KINDS, runWeeklyChecks } from '../checks/weekly';
import type { DateRange } from '../domain';
import { renderPartnerEscalation } from '../email/partner-escalation';
import { finishWithAdminSummary, type JobDeps, type JobResult, recordRun } from './context';
import { deliver, type DeliveryResult } from './deliver';

export async function runFriday(deps: JobDeps, week: DateRange): Promise<JobResult> {
  return recordRun(deps, 'friday', week.start, async () => {
    const [users, entries] = await Promise.all([
      deps.karbon.listUsers(),
      deps.karbon.listTimeEntries(week),
    ]);
    // Only the missing/minimal result matters on Friday; the indicator checks
    // were Tuesday's job, so ad hoc inputs are left empty here.
    const review = runWeeklyChecks({
      week,
      roster: deps.roster,
      users,
      entries,
      internalClientKeys: deps.internalClientKeys,
      adHocWorkItemKeys: new Set(),
      clientNames: new Map(),
      priorAdHocStreak: () => 0,
      policy: deps.policy,
    });

    const stillMissing = new Set(
      review.people
        .filter((p) => p.flags.some((f) => MISSING_KINDS.has(f.kind)))
        .map((p) => p.member.email),
    );
    const tuesday = deps.store ? await deps.store.tuesdayMissing(week.start) : null;
    const notes: string[] = [];
    if (tuesday === null) {
      notes.push(
        deps.store
          ? 'The Tuesday review did not run for this week, so everyone still missing time is escalated.'
          : 'Dry run: no Tuesday history is read, so everyone still missing time is shown.',
      );
    }
    const prior = deps.store
      ? await deps.store.priorEscalationCounts(week.start, deps.policy.escalationLookbackWeeks)
      : new Map<string, number>();
    const rows = escalations({
      review,
      flaggedTuesday: tuesday ?? stillMissing,
      priorEscalations: (email) => prior.get(email) ?? 0,
      lookbackWeeks: deps.policy.escalationLookbackWeeks,
    });

    const partners = deps.roster.recipients.filter((r) => r.role === 'partner').map((r) => r.email);
    const deliveries: DeliveryResult[] = [];
    if (rows.length > 0) {
      const historyStartsWeek = deps.store
        ? ((await deps.store.firstFridayWeek()) ?? week.start)
        : null;
      deliveries.push(
        await deliver(deps.delivery, {
          kind: 'partner_escalation',
          period: week.start,
          recipientKey: 'partners',
          to: partners,
          content: renderPartnerEscalation({
            week,
            rows,
            historyStartsWeek,
            lookbackWeeks: deps.policy.escalationLookbackWeeks,
          }),
        }),
      );
    } else {
      notes.push('Nobody to escalate: everyone flagged on Tuesday has caught up.');
    }

    if (deps.store && !deps.delivery.dryRun) {
      await deps.store.saveWeeklyResults(week.start, 'friday', review.people);
      await deps.store.saveEscalations(
        week.start,
        rows.map((r) => ({ email: r.member.email, kind: r.kind })),
      );
    }

    const sections = [
      { title: 'Notes', lines: notes },
      {
        title: 'Escalated',
        lines: rows.map(
          (r) => `${r.member.name} — ${r.weeksFlagged} of the last ${r.lookbackWeeks} weeks`,
        ),
      },
    ];
    const all = await finishWithAdminSummary(
      deps,
      {
        job: 'friday',
        period: week.start,
        title: `Friday escalation run: week of ${shortDate(week.start)}`,
        sub: `${rows.length} escalated`,
        sections,
      },
      deliveries,
    );
    return {
      period: week.start,
      deliveries: all,
      admin: sections,
      summary: {
        escalated: rows.length,
        tuesdayRan: tuesday !== null,
        emails: all.map((d) => `${d.kind}:${d.recipientKey}:${d.outcome}`),
      },
    };
  });
}
