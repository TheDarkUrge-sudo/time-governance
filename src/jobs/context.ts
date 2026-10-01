import type { Store } from '../db/store';
import type { Policy, Roster } from '../domain';
import type { AdminSection } from '../email/admin-summary';
import { renderAdminSummary } from '../email/admin-summary';
import type { KarbonClient } from '../karbon/client';
import { deliver, type DeliveryContext, type DeliveryResult, describeResults } from './deliver';

export interface JobDeps {
  karbon: KarbonClient;
  /** Null in a dry run: nothing is read from or written to the database. */
  store: Store | null;
  roster: Roster;
  policy: Policy;
  delivery: DeliveryContext;
  adminTo: string[];
  internalClientKeys: ReadonlySet<string>;
  adHocTitle: string;
  /** Weekly history older than this many days is purged after each Tuesday run. */
  retentionDays: number;
}

export interface JobResult {
  period: string;
  deliveries: DeliveryResult[];
  admin: AdminSection[];
  summary: Record<string, unknown>;
}

/** Sends the admin summary last, so it can report what the other emails did. */
export async function finishWithAdminSummary(
  deps: JobDeps,
  opts: { job: string; period: string; title: string; sub: string; sections: AdminSection[] },
  deliveries: DeliveryResult[],
): Promise<DeliveryResult[]> {
  const sections: AdminSection[] = [
    { title: 'Emails', lines: describeResults(deliveries) },
    ...opts.sections,
  ];
  const admin = await deliver(deps.delivery, {
    kind: 'admin_summary',
    period: opts.period,
    recipientKey: `admin:${opts.job}`,
    to: deps.adminTo,
    content: renderAdminSummary({ title: opts.title, sub: opts.sub, sections }),
  });
  return [...deliveries, admin];
}

/** Wraps a job in a job_runs row (when there is a database). */
export async function recordRun<T extends JobResult>(
  deps: JobDeps,
  job: 'tuesday' | 'friday' | 'monthly',
  period: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!deps.store || deps.delivery.dryRun) return fn();
  const id = await deps.store.startRun(job, period);
  try {
    const result = await fn();
    await deps.store.finishRun(id, { status: 'ok', summary: result.summary });
    return result;
  } catch (err) {
    await deps.store.finishRun(id, {
      status: 'failed',
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    throw err;
  }
}

export function rosterHygiene(
  roster: Roster,
  entriesByUser: Map<string, number>,
  users: { id: string; name: string | null; email: string | null }[],
): string[] {
  const onRoster = new Set(roster.members.map((m) => m.email));
  const lines: string[] = [];
  for (const u of users) {
    const minutes = entriesByUser.get(u.id) ?? 0;
    if (minutes === 0) continue;
    const email = u.email?.toLowerCase() ?? '';
    if (onRoster.has(email)) continue;
    lines.push(`${u.name ?? u.id} (${u.email ?? 'no email'}) — ${(minutes / 60).toFixed(1)} h`);
  }
  return lines.sort();
}

export function minutesByUser(
  entries: { userKey: string; minutes: number }[],
): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entries) m.set(e.userKey, (m.get(e.userKey) ?? 0) + e.minutes);
  return m;
}
