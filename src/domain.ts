/**
 * The shared shapes every layer speaks. Minutes stay integers until the render
 * edge; dates are firm-local calendar dates as YYYY-MM-DD strings.
 */

/** How the firm classifies a Karbon task type (the roster workbook's Task Types tab). */
export type TaskCategory = 'billable' | 'non_billable' | 'pto' | 'sick';

export interface RosterMember {
  name: string;
  /** Lower-cased; the join key to Karbon users. */
  email: string;
  department: string;
  managerName: string | null;
  managerEmail: string | null;
  /** "CSA-1" etc. — resolved to a person through the Recipients tab. */
  csaSlot: string | null;
  active: boolean;
  /** 0–1. Null = no target set (the report shows a dash). */
  utilizationTarget: number | null;
  /** Null = full time (FULL_TIME_WEEK_HOURS). */
  expectedWeeklyHours: number | null;
  /** Partners, admin, anyone not expected to log time. */
  excluded: boolean;
  hireDate: string | null;
}

export interface Recipient {
  /** 'manager' rows only link a manager's email to their Karbon governance client. */
  role: 'csa' | 'partner' | 'manager';
  /** The CSA slot ("CSA-1"); null for partners. */
  slot: string | null;
  name: string | null;
  email: string;
  /**
   * Karbon client ID (UserDefinedIdentifier) of this person's Hidden
   * Governance client, where their governance notes are posted. Optional.
   */
  karbonClientId: string | null;
}

export interface Holiday {
  date: string;
  name: string;
}

export interface Roster {
  members: RosterMember[];
  recipients: Recipient[];
  /** Keyed by lower-cased task type name. */
  taskTypes: Map<string, TaskCategory>;
  holidays: Holiday[];
}

export interface KarbonUser {
  id: string;
  name: string | null;
  email: string | null;
}

export interface TimeEntry {
  key: string;
  userKey: string;
  date: string;
  minutes: number;
  clientKey: string | null;
  workItemKey: string | null;
  roleName: string | null;
  taskTypeName: string | null;
  description: string | null;
  /** The Karbon timesheet the entry belongs to (opens at KARBON_TIMESHEET_URL). */
  timesheetKey: string | null;
}

export interface DateRange {
  /** Inclusive. */
  start: string;
  /** Inclusive. */
  end: string;
}

/** The thresholds, from the environment (plan decisions 1 and 5). */
export interface Policy {
  minimalWeekHours: number;
  fullTimeWeekHours: number;
  adHocWeeklyHours: number;
  adHocRecurringWeeks: number;
  /** Minimum ad hoc hours in a week for it to count toward a streak. */
  adHocRecurringMinHours: number;
  nonBillableMinDescriptionChars: number;
  internalOnlyRoleMarker: string;
  escalationLookbackWeeks: number;
  /** A month-over-month utilization drop (points) worth calling out even above target. */
  utilizationDropPoints: number;
}
