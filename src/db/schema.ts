/**
 * The database: the roster (replaced whole on each upload), the weekly
 * history the Friday and ad hoc checks need, and the send/run logs that make
 * every job safe to re-run.
 *
 * Change this file → `pnpm db:generate` → commit the generated SQL. Never
 * hand-write migration SQL.
 */
import {
  boolean,
  date,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const rosterMembers = pgTable('roster_members', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  department: text('department').notNull(),
  managerName: text('manager_name'),
  managerEmail: text('manager_email'),
  csaSlot: text('csa_slot'),
  active: boolean('active').notNull(),
  utilizationTarget: doublePrecision('utilization_target'),
  expectedWeeklyHours: doublePrecision('expected_weekly_hours'),
  excluded: boolean('excluded').notNull().default(false),
  hireDate: date('hire_date', { mode: 'string' }),
});

export const recipients = pgTable('recipients', {
  id: serial('id').primaryKey(),
  role: text('role', { enum: ['csa', 'partner'] }).notNull(),
  slot: text('slot'),
  name: text('name'),
  email: text('email').notNull(),
});

export const taskTypes = pgTable('task_types', {
  /** Lower-cased task type name — the lookup key. */
  key: text('key').primaryKey(),
  category: text('category', { enum: ['billable', 'non_billable', 'pto', 'sick'] }).notNull(),
});

export const holidays = pgTable('holidays', {
  date: date('date', { mode: 'string' }).primaryKey(),
  name: text('name').notNull(),
});

/** One row per applied roster upload — what changed, and who/what file. */
export const rosterImports = pgTable('roster_imports', {
  id: serial('id').primaryKey(),
  fileName: text('file_name').notNull(),
  changes: jsonb('changes').$type<string[]>().notNull(),
  warnings: jsonb('warnings').$type<string[]>().notNull(),
  createdAt: createdAt(),
});

/** Each person's result for a week, from the Tuesday review and the Friday re-check. */
export const weeklyResults = pgTable(
  'weekly_results',
  {
    id: serial('id').primaryKey(),
    weekStart: date('week_start', { mode: 'string' }).notNull(),
    phase: text('phase', { enum: ['tuesday', 'friday'] }).notNull(),
    email: text('email').notNull(),
    /** Snapshotted each week so history stays readable after someone leaves the roster. */
    name: text('name'),
    department: text('department'),
    managerName: text('manager_name'),
    karbonUserId: text('karbon_user_id').notNull(),
    flags: jsonb('flags').$type<{ kind: string; minutes: number; detail: string }[]>().notNull(),
    minutes: jsonb('minutes').$type<Record<string, number>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('weekly_results_week_phase_email').on(t.weekStart, t.phase, t.email)],
);

/** Who was escalated to the Partners, by week — the "weeks flagged" history. */
export const escalations = pgTable(
  'escalations',
  {
    id: serial('id').primaryKey(),
    weekStart: date('week_start', { mode: 'string' }).notNull(),
    email: text('email').notNull(),
    kind: text('kind').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('escalations_week_email').on(t.weekStart, t.email)],
);

/** Ad hoc minutes per person × client × week — how check 4 spots a recurring pattern. */
export const adHocUsage = pgTable(
  'ad_hoc_usage',
  {
    id: serial('id').primaryKey(),
    weekStart: date('week_start', { mode: 'string' }).notNull(),
    karbonUserId: text('karbon_user_id').notNull(),
    clientKey: text('client_key').notNull(),
    minutes: integer('minutes').notNull(),
  },
  (t) => [
    uniqueIndex('ad_hoc_usage_week_user_client').on(t.weekStart, t.karbonUserId, t.clientKey),
  ],
);

/**
 * Every email, claimed BEFORE it is sent. The unique key makes a re-run (or a
 * double cron fire) skip what already went out; a definitive send failure
 * deletes the claim so the next run retries it.
 */
export const emailSends = pgTable(
  'email_sends',
  {
    id: serial('id').primaryKey(),
    kind: text('kind').notNull(),
    period: text('period').notNull(),
    recipient: text('recipient').notNull(),
    mode: text('mode', { enum: ['shadow', 'live'] }).notNull(),
    deliveredTo: text('delivered_to').notNull(),
    subject: text('subject').notNull(),
    status: text('status', { enum: ['sending', 'sent'] }).notNull(),
    messageId: text('message_id'),
    createdAt: createdAt(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('email_sends_once').on(t.kind, t.period, t.recipient, t.mode)],
);

export const jobRuns = pgTable('job_runs', {
  id: serial('id').primaryKey(),
  job: text('job', { enum: ['tuesday', 'friday', 'monthly'] }).notNull(),
  period: text('period').notNull(),
  status: text('status', { enum: ['running', 'ok', 'failed'] }).notNull(),
  summary: jsonb('summary').$type<Record<string, unknown>>(),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});
