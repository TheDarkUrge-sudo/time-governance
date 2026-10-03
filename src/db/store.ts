/** Every read and write the jobs make. Thin: SQL in, domain shapes out. */
import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';

import { addDays } from '../calendar';
import type { AdHocUsage, PersonWeek } from '../checks/weekly';
import { MISSING_KINDS } from '../checks/weekly';
import type { Roster } from '../domain';
import type { Db } from './client';
import {
  adHocUsage,
  emailSends,
  escalations,
  holidays,
  jobRuns,
  karbonNotes,
  recipients,
  rosterImports,
  rosterMembers,
  taskTypes,
  weeklyResults,
} from './schema';

export type JobName = 'tuesday' | 'friday' | 'monthly';
export type SendMode = 'shadow' | 'live';

export class Store {
  constructor(readonly db: Db) {}

  /* ── Roster ───────────────────────────────────────────────────────────── */

  async loadRoster(): Promise<Roster> {
    const [members, recips, types, days] = await Promise.all([
      this.db.select().from(rosterMembers).orderBy(asc(rosterMembers.name)),
      this.db.select().from(recipients).orderBy(asc(recipients.id)),
      this.db.select().from(taskTypes),
      this.db.select().from(holidays).orderBy(asc(holidays.date)),
    ]);
    return {
      members: members.map((m) => ({
        name: m.name,
        email: m.email,
        department: m.department,
        managerName: m.managerName,
        managerEmail: m.managerEmail,
        csaSlot: m.csaSlot,
        active: m.active,
        utilizationTarget: m.utilizationTarget,
        expectedWeeklyHours: m.expectedWeeklyHours,
        excluded: m.excluded,
        hireDate: m.hireDate,
      })),
      recipients: recips.map((r) => ({
        role: r.role,
        slot: r.slot,
        name: r.name,
        email: r.email,
        karbonClientId: r.karbonClientId,
      })),
      taskTypes: new Map(types.map((t) => [t.key, t.category])),
      holidays: days.map((h) => ({ date: h.date, name: h.name })),
    };
  }

  /** Replaces the whole roster in one transaction, and records the upload. */
  async replaceRoster(
    roster: Roster,
    audit: { fileName: string; changes: string[]; warnings: string[] },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(rosterMembers);
      await tx.delete(recipients);
      await tx.delete(taskTypes);
      await tx.delete(holidays);
      if (roster.members.length > 0) await tx.insert(rosterMembers).values(roster.members);
      if (roster.recipients.length > 0) await tx.insert(recipients).values(roster.recipients);
      if (roster.taskTypes.size > 0) {
        await tx
          .insert(taskTypes)
          .values([...roster.taskTypes].map(([key, category]) => ({ key, category })));
      }
      if (roster.holidays.length > 0) await tx.insert(holidays).values(roster.holidays);
      await tx.insert(rosterImports).values(audit);
    });
  }

  async lastRosterImport(): Promise<{ fileName: string; createdAt: Date } | null> {
    const rows = await this.db
      .select({ fileName: rosterImports.fileName, createdAt: rosterImports.createdAt })
      .from(rosterImports)
      .orderBy(sql`${rosterImports.id} desc`)
      .limit(1);
    return rows[0] ?? null;
  }

  /* ── Weekly history ───────────────────────────────────────────────────── */

  async saveWeeklyResults(
    weekStart: string,
    phase: 'tuesday' | 'friday',
    people: PersonWeek[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(weeklyResults)
        .where(and(eq(weeklyResults.weekStart, weekStart), eq(weeklyResults.phase, phase)));
      if (people.length === 0) return;
      await tx.insert(weeklyResults).values(
        people.map((p) => ({
          weekStart,
          phase,
          email: p.member.email,
          name: p.member.name,
          department: p.member.department,
          managerName: p.member.managerName,
          karbonUserId: p.karbonUserId,
          flags: p.flags,
          minutes: { ...p.minutes },
        })),
      );
    });
  }

  /** Emails the Tuesday review flagged for missing or minimal time; null if Tuesday never ran. */
  async tuesdayMissing(weekStart: string): Promise<Set<string> | null> {
    const rows = await this.db
      .select({ email: weeklyResults.email, flags: weeklyResults.flags })
      .from(weeklyResults)
      .where(and(eq(weeklyResults.weekStart, weekStart), eq(weeklyResults.phase, 'tuesday')));
    if (rows.length === 0) {
      const ran = await this.lastRun('tuesday', weekStart);
      if (ran?.status !== 'ok') return null;
    }
    return new Set(
      rows
        .filter((r) => r.flags.some((f) => MISSING_KINDS.has(f.kind as never)))
        .map((r) => r.email),
    );
  }

  async saveEscalations(weekStart: string, rows: { email: string; kind: string }[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(escalations).where(eq(escalations.weekStart, weekStart));
      if (rows.length > 0) {
        await tx.insert(escalations).values(rows.map((r) => ({ weekStart, ...r })));
      }
    });
  }

  /** Weekly results (both phases) for weeks in [from, before), optionally one person. */
  async weeklyHistory(opts: { from?: string; before?: string; email?: string }) {
    const where = [
      opts.from ? gte(weeklyResults.weekStart, opts.from) : undefined,
      opts.before ? lt(weeklyResults.weekStart, opts.before) : undefined,
      opts.email ? eq(weeklyResults.email, opts.email) : undefined,
    ].filter((w) => w !== undefined);
    return this.db
      .select()
      .from(weeklyResults)
      .where(where.length ? and(...where) : undefined)
      .orderBy(asc(weeklyResults.weekStart), asc(weeklyResults.email));
  }

  /** Escalations for weeks in [from, before), optionally one person. */
  async escalationHistory(opts: { from?: string; before?: string; email?: string }) {
    const where = [
      opts.from ? gte(escalations.weekStart, opts.from) : undefined,
      opts.before ? lt(escalations.weekStart, opts.before) : undefined,
      opts.email ? eq(escalations.email, opts.email) : undefined,
    ].filter((w) => w !== undefined);
    return this.db
      .select()
      .from(escalations)
      .where(where.length ? and(...where) : undefined)
      .orderBy(asc(escalations.weekStart), asc(escalations.email));
  }

  /** Everyone with any stored history, with the latest name/department seen for them. */
  async peopleWithHistory(): Promise<
    { email: string; name: string | null; department: string | null; managerName: string | null }[]
  > {
    const rows = await this.db
      .selectDistinctOn([weeklyResults.email], {
        email: weeklyResults.email,
        name: weeklyResults.name,
        department: weeklyResults.department,
        managerName: weeklyResults.managerName,
      })
      .from(weeklyResults)
      .orderBy(weeklyResults.email, sql`${weeklyResults.weekStart} desc`);
    return rows;
  }

  /** Escalations per email for weeks in [from, before). */
  async escalationCountsBetween(from: string, before: string): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ email: escalations.email, n: sql<number>`count(*)::int` })
      .from(escalations)
      .where(and(gte(escalations.weekStart, from), lt(escalations.weekStart, before)))
      .groupBy(escalations.email);
    return new Map(rows.map((r) => [r.email, Number(r.n)]));
  }

  /** Escalations per email in the (lookback − 1) weeks before `weekStart`. */
  priorEscalationCounts(weekStart: string, lookbackWeeks: number): Promise<Map<string, number>> {
    return this.escalationCountsBetween(
      addDays(weekStart, -7 * Math.max(0, lookbackWeeks - 1)),
      weekStart,
    );
  }

  /** The first week a Friday run completed — where "weeks flagged" history begins. */
  async firstFridayWeek(): Promise<string | null> {
    const rows = await this.db
      .select({ period: jobRuns.period })
      .from(jobRuns)
      .where(and(eq(jobRuns.job, 'friday'), eq(jobRuns.status, 'ok')))
      .orderBy(asc(jobRuns.period))
      .limit(1);
    return rows[0]?.period ?? null;
  }

  async saveAdHocUsage(weekStart: string, usage: AdHocUsage[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(adHocUsage).where(eq(adHocUsage.weekStart, weekStart));
      if (usage.length === 0) return;
      await tx.insert(adHocUsage).values(
        usage.map((u) => ({
          weekStart,
          karbonUserId: u.userKey,
          clientKey: u.clientKey,
          minutes: u.minutes,
        })),
      );
    });
  }

  /**
   * A lookup of how many consecutive weeks, immediately before `weekStart`,
   * each user logged ad hoc time to each client.
   */
  async adHocStreaks(
    weekStart: string,
    maxWeeks: number,
    minMinutes = 0,
  ): Promise<(userKey: string, clientKey: string) => number> {
    const from = addDays(weekStart, -7 * maxWeeks);
    const rows = await this.db
      .select({
        weekStart: adHocUsage.weekStart,
        user: adHocUsage.karbonUserId,
        client: adHocUsage.clientKey,
      })
      .from(adHocUsage)
      .where(
        and(
          gte(adHocUsage.weekStart, from),
          lt(adHocUsage.weekStart, weekStart),
          gte(adHocUsage.minutes, minMinutes),
        ),
      );
    const weeks = new Map<string, Set<string>>();
    for (const r of rows) {
      const k = `${r.user}|${r.client}`;
      const s = weeks.get(k) ?? new Set<string>();
      s.add(r.weekStart);
      weeks.set(k, s);
    }
    return (userKey, clientKey) => {
      const s = weeks.get(`${userKey}|${clientKey}`);
      if (!s) return 0;
      let n = 0;
      for (let w = addDays(weekStart, -7); s.has(w); w = addDays(w, -7)) n++;
      return n;
    };
  }

  /** Deletes weekly history, sends and runs from before `cutoff` (YYYY-MM-DD). */
  async purgeHistoryBefore(cutoff: string): Promise<void> {
    const at = new Date(`${cutoff}T00:00:00Z`);
    await this.db.transaction(async (tx) => {
      await tx.delete(weeklyResults).where(lt(weeklyResults.weekStart, cutoff));
      await tx.delete(escalations).where(lt(escalations.weekStart, cutoff));
      await tx.delete(adHocUsage).where(lt(adHocUsage.weekStart, cutoff));
      await tx.delete(emailSends).where(lt(emailSends.createdAt, at));
      await tx.delete(jobRuns).where(lt(jobRuns.startedAt, at));
    });
  }

  /* ── Sends ────────────────────────────────────────────────────────────── */

  /** Claims a send; returns its id, or null if it was already claimed (sent or in flight). */
  async claimSend(c: {
    kind: string;
    period: string;
    recipient: string;
    mode: SendMode;
    deliveredTo: string;
    subject: string;
  }): Promise<number | null> {
    const rows = await this.db
      .insert(emailSends)
      .values({ ...c, status: 'sending' })
      .onConflictDoNothing()
      .returning({ id: emailSends.id });
    return rows[0]?.id ?? null;
  }

  /** The status of the claim on this send ('sending' = an attempt that never finished), or null. */
  async sendClaimStatus(c: {
    kind: string;
    period: string;
    recipient: string;
    mode: SendMode;
  }): Promise<string | null> {
    const rows = await this.db
      .select({ status: emailSends.status })
      .from(emailSends)
      .where(
        and(
          eq(emailSends.kind, c.kind),
          eq(emailSends.period, c.period),
          eq(emailSends.recipient, c.recipient),
          eq(emailSends.mode, c.mode),
        ),
      )
      .limit(1);
    return rows[0]?.status ?? null;
  }

  async markSent(id: number, messageId: string): Promise<void> {
    await this.db
      .update(emailSends)
      .set({ status: 'sent', messageId, sentAt: new Date() })
      .where(eq(emailSends.id, id));
  }

  async releaseSend(id: number): Promise<void> {
    await this.db.delete(emailSends).where(eq(emailSends.id, id));
  }

  /* ── Karbon governance notes ──────────────────────────────────────────── */

  async claimNote(c: {
    kind: string;
    period: string;
    subjectKey: string;
    mode: SendMode;
    clientKey: string;
    subject: string;
  }): Promise<number | null> {
    const rows = await this.db
      .insert(karbonNotes)
      .values({ ...c, status: 'posting' })
      .onConflictDoNothing()
      .returning({ id: karbonNotes.id });
    return rows[0]?.id ?? null;
  }

  /** The status of the claim on this note ('posting' = an attempt that never finished), or null. */
  async noteClaimStatus(c: {
    kind: string;
    period: string;
    subjectKey: string;
    mode: SendMode;
  }): Promise<string | null> {
    const rows = await this.db
      .select({ status: karbonNotes.status })
      .from(karbonNotes)
      .where(
        and(
          eq(karbonNotes.kind, c.kind),
          eq(karbonNotes.period, c.period),
          eq(karbonNotes.subjectKey, c.subjectKey),
          eq(karbonNotes.mode, c.mode),
        ),
      )
      .limit(1);
    return rows[0]?.status ?? null;
  }

  async markNotePosted(id: number, noteId: string): Promise<void> {
    await this.db
      .update(karbonNotes)
      .set({ status: 'posted', noteId })
      .where(eq(karbonNotes.id, id));
  }

  async releaseNote(id: number): Promise<void> {
    await this.db.delete(karbonNotes).where(eq(karbonNotes.id, id));
  }

  /** Posted notes of one kind and period, by subject key → Karbon note id. */
  async notesFor(kind: string, period: string, mode: SendMode): Promise<Map<string, string>> {
    const rows = await this.db
      .select({ subjectKey: karbonNotes.subjectKey, noteId: karbonNotes.noteId })
      .from(karbonNotes)
      .where(
        and(
          eq(karbonNotes.kind, kind),
          eq(karbonNotes.period, period),
          eq(karbonNotes.mode, mode),
          eq(karbonNotes.status, 'posted'),
        ),
      );
    return new Map(rows.filter((r) => r.noteId).map((r) => [r.subjectKey, r.noteId!]));
  }

  /* ── Runs ─────────────────────────────────────────────────────────────── */

  async startRun(job: JobName, period: string): Promise<number> {
    const rows = await this.db
      .insert(jobRuns)
      .values({ job, period, status: 'running' })
      .returning({ id: jobRuns.id });
    return rows[0]!.id;
  }

  async finishRun(
    id: number,
    outcome: { status: 'ok' | 'failed'; summary?: Record<string, unknown>; error?: string },
  ): Promise<void> {
    await this.db
      .update(jobRuns)
      .set({ ...outcome, finishedAt: new Date() })
      .where(eq(jobRuns.id, id));
  }

  async lastRun(job: JobName, period: string) {
    const rows = await this.db
      .select()
      .from(jobRuns)
      .where(and(eq(jobRuns.job, job), eq(jobRuns.period, period)))
      .orderBy(sql`${jobRuns.id} desc`)
      .limit(1);
    return rows[0] ?? null;
  }

  /** Whether `job` has any run (any outcome) for a period before `period` — i.e. it was already live. */
  async hadEarlierRun(job: JobName, period: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: jobRuns.id })
      .from(jobRuns)
      .where(and(eq(jobRuns.job, job), lt(jobRuns.period, period)))
      .limit(1);
    return rows.length > 0;
  }

  async recentRuns(limit = 10) {
    return this.db
      .select()
      .from(jobRuns)
      .orderBy(sql`${jobRuns.id} desc`)
      .limit(limit);
  }

  async countRoster(): Promise<{ members: number; taskTypes: number }> {
    const [m] = await this.db.select({ n: sql<number>`count(*)::int` }).from(rosterMembers);
    const [t] = await this.db.select({ n: sql<number>`count(*)::int` }).from(taskTypes);
    return { members: Number(m?.n ?? 0), taskTypes: Number(t?.n ?? 0) };
  }
}
