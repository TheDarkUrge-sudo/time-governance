import type { Policy } from './domain';
import { env } from './env';

export function policyFromEnv(): Policy {
  return {
    minimalWeekHours: env.MINIMAL_WEEK_HOURS,
    fullTimeWeekHours: env.FULL_TIME_WEEK_HOURS,
    adHocWeeklyHours: env.AD_HOC_WEEKLY_HOURS,
    adHocRecurringWeeks: env.AD_HOC_RECURRING_WEEKS,
    adHocRecurringMinHours: env.AD_HOC_RECURRING_MIN_HOURS,
    nonBillableMinDescriptionChars: env.NONBILLABLE_MIN_DESCRIPTION_CHARS,
    internalOnlyRoleMarker: env.INTERNAL_ONLY_ROLE_MARKER,
    escalationLookbackWeeks: env.ESCALATION_LOOKBACK_WEEKS,
    utilizationDropPoints: env.UTILIZATION_DROP_POINTS,
  };
}

/** The approved defaults, for tests and previews. */
export const DEFAULT_POLICY: Policy = {
  minimalWeekHours: 20,
  fullTimeWeekHours: 40,
  adHocWeeklyHours: 4,
  adHocRecurringWeeks: 3,
  adHocRecurringMinHours: 1,
  nonBillableMinDescriptionChars: 10,
  internalOnlyRoleMarker: '(Internal Only)',
  escalationLookbackWeeks: 4,
  utilizationDropPoints: 10,
};
