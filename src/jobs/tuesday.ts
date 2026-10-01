/** Tuesday: run the six checks over last week and email each CSA their staff's flags. */
import { addDays, shortDate } from '../calendar';
import { runWeeklyChecks } from '../checks/weekly';
import type { DateRange, RosterMember } from '../domain';
import { unclassifiedLine } from '../email/admin-summary';
import { renderCsaWeekly } from '../email/csa-weekly';
import {
  finishWithAdminSummary,
  type JobDeps,
  type JobResult,
  minutesByUser,
  recordRun,
  rosterHygiene,
} from './context';
import { deliver, type DeliveryResult } from './deliver';

export async function runTuesday(deps: JobDeps, week: DateRange): Promise<JobResult> {
  return recordRun(deps, 'tuesday', week.start, async () => {
    const [users, entries, adHoc] = await Promise.all([
      deps.karbon.listUsers(),
      deps.karbon.listTimeEntries(week),
      deps.karbon.listAdHocWorkItems(deps.adHocTitle),
    ]);
    const streaks = deps.store
      ? await deps.store.adHocStreaks(
          week.start,
          deps.policy.adHocRecurringWeeks,
          deps.policy.adHocRecurringMinHours * 60,
        )
      : () => 0;

    const review = runWeeklyChecks({
      week,
      roster: deps.roster,
      users,
      entries,
      internalClientKeys: deps.internalClientKeys,
      adHocWorkItemKeys: new Set(adHoc.map((w) => w.workItemKey)),
      clientNames: new Map(
        adHoc.filter((w) => w.clientName).map((w) => [w.clientKey, w.clientName!]),
      ),
      priorAdHocStreak: streaks,
      policy: deps.policy,
    });

    // One email per CSA slot, to everyone on the Recipients tab for that slot.
    const csaRecipients = new Map<string, { emails: string[]; name: string | null }>();
    for (const r of deps.roster.recipients) {
      if (r.role !== 'csa' || !r.slot) continue;
      const entry = csaRecipients.get(r.slot) ?? { emails: [], name: null };
      entry.emails.push(r.email);
      entry.name = entry.name ? `${entry.name}, ${r.name ?? r.email}` : (r.name ?? r.email);
      csaRecipients.set(r.slot, entry);
    }

    const deliveries: DeliveryResult[] = [];
    const unrouted: RosterMember[] = [];
    for (const [slot, who] of csaRecipients) {
      const people = review.people.filter((p) => p.member.csaSlot === slot);
      const unmatched = review.unmatched.filter((m) => m.csaSlot === slot);
      if (people.length === 0 && unmatched.length === 0) continue;
      deliveries.push(
        await deliver(deps.delivery, {
          kind: 'csa_weekly',
          period: week.start,
          recipientKey: `csa:${slot}`,
          to: who.emails,
          content: renderCsaWeekly({ week, csaName: who.name, people, unmatched }),
        }),
      );
    }
    for (const p of review.people) {
      if (!p.member.csaSlot || !csaRecipients.has(p.member.csaSlot)) unrouted.push(p.member);
    }

    if (deps.store && !deps.delivery.dryRun) {
      await deps.store.saveWeeklyResults(week.start, 'tuesday', review.people);
      await deps.store.saveAdHocUsage(week.start, review.adHocUsage);
      if (deps.retentionDays > 0) {
        await deps.store.purgeHistoryBefore(addDays(week.start, -deps.retentionDays));
      }
    }

    const flagCount = review.people.reduce((n, p) => n + p.flags.length, 0);
    const sections = [
      {
        title: 'Setup',
        lines: deps.setupNotes,
      },
      {
        title: 'Flags no CSA received (no CSA Assigned, or nobody on the Recipients tab for it)',
        lines: unrouted
          .filter((m) => review.people.find((p) => p.member === m)?.flags.length)
          .map((m) => `${m.name} (${m.csaSlot ?? 'no CSA'})`),
      },
      {
        title: 'Not checked — no Karbon user has this roster email',
        lines: review.unmatched.map((m) => `${m.name} <${m.email}>`),
      },
      {
        title:
          'Task types not on the Task Types tab (not counted as billable, non-billable, PTO or sick)',
        lines: review.unclassifiedTaskTypes.map(unclassifiedLine),
      },
      {
        title: 'Logged time in Karbon but not on the roster',
        lines: rosterHygiene(deps.roster, minutesByUser(entries), users),
      },
    ];
    const label = `${shortDate(week.start)} – ${shortDate(week.end)}`;
    const all = await finishWithAdminSummary(
      deps,
      {
        job: 'tuesday',
        period: week.start,
        title: `Tuesday review run: week of ${shortDate(week.start)}`,
        sub: `${review.people.length} people checked · ${flagCount} flags · ${label}`,
        sections,
      },
      deliveries,
    );

    return {
      period: week.start,
      deliveries: all,
      admin: sections,
      summary: {
        checked: review.people.length,
        flags: flagCount,
        unmatched: review.unmatched.length,
        unclassifiedTaskTypes: review.unclassifiedTaskTypes.length,
        emails: all.map((d) => `${d.kind}:${d.recipientKey}:${d.outcome}`),
      },
    };
  });
}
