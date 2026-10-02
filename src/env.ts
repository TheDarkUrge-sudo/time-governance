/**
 * Environment — Zod-validated once at import, fail fast on a bad value.
 *
 * Every integration is OPTIONAL at boot: without Karbon credentials the jobs
 * refuse to run (and say why), without SendGrid nothing is sent, and without a
 * database only the file-based dry run works. That keeps the CLI usable for a
 * dry run before any credential exists.
 */
import 'dotenv/config';

import { z } from 'zod/v4';

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalString = z.preprocess(blankToUndefined, z.string().trim().optional());
const optionalEmail = z.preprocess(blankToUndefined, z.email().optional());
const number = (fallback: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().nonnegative().default(fallback));
const csv = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  z.array(z.string()),
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: optionalString,

  KARBON_API_KEY: optionalString,
  KARBON_API_SECRET: optionalString,
  /**
   * The internal HFA client, by its Karbon client ID (the firm's is 99999) —
   * resolved to Karbon's internal key at run time. Checks 1–4 key off it.
   * Unset = 99999; set to blank to disable.
   */
  KARBON_INTERNAL_CLIENT_IDS: z.preprocess((v) => (v === undefined ? '99999' : v), csv),
  /** Optional: internal client(s) by Karbon key directly, if the ID lookup can't be used. */
  KARBON_INTERNAL_CLIENT_KEYS: csv,
  /** Every client has an ad hoc work item; this is the title text that finds them. */
  KARBON_AD_HOC_TITLE: z.preprocess(blankToUndefined, z.string().default('Ad Hoc')),

  SENDGRID_API_KEY: optionalString,
  SENDGRID_FROM_EMAIL: optionalEmail,
  SENDGRID_FROM_NAME: z.preprocess(blankToUndefined, z.string().default('HFA Time Governance')),
  TG_REPLY_TO: optionalEmail,

  /** off = compute and log only · shadow = every email goes to TG_SHADOW_TO · live = real recipients. */
  TG_MODE: z.preprocess(blankToUndefined, z.enum(['off', 'shadow', 'live']).default('shadow')),
  TG_SHADOW_TO: optionalEmail,
  /** Gets a short summary after every run: what was sent, plus roster fixes needed. */
  TG_ADMIN_TO: csv.pipe(z.array(z.email())),

  /**
   * Karbon governance notes: off (default) · shadow (every note goes to the
   * shadow governance client, assigned to TG_SHADOW_TO) · live. Notes only
   * ever go to Hidden clients of KARBON_GOVERNANCE_CLIENT_TYPE.
   */
  TG_KARBON_NOTES: z.preprocess(blankToUndefined, z.enum(['off', 'shadow', 'live']).default('off')),
  /** The Karbon user the notes are posted as. Required when notes are on. */
  KARBON_NOTE_AUTHOR: optionalEmail,
  /** The client type governance clients must have (blank = don't check the type). */
  KARBON_GOVERNANCE_CLIENT_TYPE: z.preprocess(
    (v) => (v === undefined ? 'Governance' : v),
    z.string().trim(),
  ),
  /** The governance client (by client ID) that receives every note in shadow mode. */
  KARBON_NOTES_SHADOW_CLIENT_ID: optionalString,

  FIRM_TIMEZONE: z.preprocess(blankToUndefined, z.string().default('America/New_York')),

  // Thresholds (plan, decisions 1 and 5 — approved defaults).
  MINIMAL_WEEK_HOURS: number(20),
  FULL_TIME_WEEK_HOURS: number(40),
  AD_HOC_WEEKLY_HOURS: number(4),
  AD_HOC_RECURRING_WEEKS: number(3),
  /** A week only counts toward an ad hoc streak with at least this much time on it. */
  AD_HOC_RECURRING_MIN_HOURS: number(1),
  NONBILLABLE_MIN_DESCRIPTION_CHARS: number(10),
  INTERNAL_ONLY_ROLE_MARKER: z.preprocess(blankToUndefined, z.string().default('(Internal Only)')),
  ESCALATION_LOOKBACK_WEEKS: number(4),
  /** A month-over-month utilization drop this large is called out even above target. */
  UTILIZATION_DROP_POINTS: number(10),
  /**
   * Weekly history, send and run logs older than this are deleted. Default ≈ 7
   * years (a typical firm record-retention period); 0 = keep forever. The
   * emails only ever look back 4 weeks and the current year — older history is
   * reachable through `pnpm tg history`.
   */
  HISTORY_RETENTION_DAYS: number(2557),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n  ${problems.join('\n  ')}`);
  }
  return parsed.data;
}

export const env = load();
