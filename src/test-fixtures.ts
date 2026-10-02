/** Builders shared by the tests. Not imported by production code. */
import type { KarbonUser, Roster, RosterMember, TaskCategory, TimeEntry } from './domain';

export function member(over: Partial<RosterMember> & { name: string }): RosterMember {
  const email = over.email ?? `${over.name.split(' ').join('.').toLowerCase()}@hfacpas.com`;
  return {
    department: 'Audit',
    managerName: 'Dana Ferris',
    managerEmail: 'dferris@hfacpas.com',
    csaSlot: 'CSA-1',
    active: true,
    utilizationTarget: 0.8,
    expectedWeeklyHours: null,
    excluded: false,
    hireDate: null,
    ...over,
    email,
  };
}

export function userFor(m: RosterMember, id = `u-${m.email.split('@')[0]}`): KarbonUser {
  return { id, name: m.name, email: m.email };
}

let seq = 0;
export function entry(over: Partial<TimeEntry> & { userKey: string; date: string }): TimeEntry {
  seq += 1;
  return {
    key: `e${seq}`,
    minutes: 60,
    clientKey: 'C-ACME',
    workItemKey: 'W-1',
    roleName: 'Staff',
    taskTypeName: 'Audit Fieldwork',
    description: 'Testing controls for year-end',
    timesheetKey: null,
    ...over,
  };
}

export const TASK_TYPES = new Map<string, TaskCategory>([
  ['audit fieldwork', 'billable'],
  ['tax return', 'billable'],
  ['admin', 'non_billable'],
  ['client meeting (non-billable)', 'non_billable'],
  ['pto', 'pto'],
  ['sick', 'sick'],
]);

export function roster(members: RosterMember[], over: Partial<Roster> = {}): Roster {
  return { members, recipients: [], taskTypes: TASK_TYPES, holidays: [], ...over };
}
