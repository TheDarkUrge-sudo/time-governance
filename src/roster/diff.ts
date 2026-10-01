/** What a roster upload would change — shown before anything is saved. */
import type { Roster, RosterMember } from '../domain';

export interface RosterDiff {
  added: RosterMember[];
  removed: RosterMember[];
  changed: { email: string; name: string; fields: string[] }[];
  recipientsChanged: boolean;
  taskTypes: { added: string[]; removed: string[]; recategorized: string[] };
  holidaysChanged: boolean;
}

const MEMBER_FIELDS: (keyof RosterMember)[] = [
  'name',
  'department',
  'managerName',
  'managerEmail',
  'csaSlot',
  'active',
  'utilizationTarget',
  'expectedWeeklyHours',
  'excluded',
  'hireDate',
];

const LABELS: Partial<Record<keyof RosterMember, string>> = {
  managerName: 'manager',
  managerEmail: 'manager email',
  csaSlot: 'CSA',
  active: 'status',
  utilizationTarget: 'target',
  expectedWeeklyHours: 'weekly hours',
  excluded: 'exclude',
  hireDate: 'hire date',
};

export function diffRoster(current: Roster, next: Roster): RosterDiff {
  const before = new Map(current.members.map((m) => [m.email, m]));
  const after = new Map(next.members.map((m) => [m.email, m]));
  const added = next.members.filter((m) => !before.has(m.email));
  const removed = current.members.filter((m) => !after.has(m.email));
  const changed: RosterDiff['changed'] = [];
  for (const m of next.members) {
    const old = before.get(m.email);
    if (!old) continue;
    const fields = MEMBER_FIELDS.filter((f) => old[f] !== m[f]).map((f) => LABELS[f] ?? f);
    if (fields.length > 0) changed.push({ email: m.email, name: m.name, fields });
  }

  const key = (r: { role: string; slot: string | null; email: string }) =>
    `${r.role}|${r.slot ?? ''}|${r.email}`;
  const recipientsChanged =
    JSON.stringify(current.recipients.map(key).sort()) !==
    JSON.stringify(next.recipients.map(key).sort());

  const taskTypes = {
    added: [...next.taskTypes.keys()].filter((k) => !current.taskTypes.has(k)),
    removed: [...current.taskTypes.keys()].filter((k) => !next.taskTypes.has(k)),
    recategorized: [...next.taskTypes]
      .filter(([k, v]) => current.taskTypes.has(k) && current.taskTypes.get(k) !== v)
      .map(([k]) => k),
  };

  const holidayKey = (r: Roster) => JSON.stringify(r.holidays.map((h) => h.date).sort());
  return {
    added,
    removed,
    changed,
    recipientsChanged,
    taskTypes,
    holidaysChanged: holidayKey(current) !== holidayKey(next),
  };
}

export function describeDiff(d: RosterDiff): string[] {
  const lines: string[] = [];
  for (const m of d.added) lines.push(`+ ${m.name} <${m.email}>`);
  for (const m of d.removed) lines.push(`- ${m.name} <${m.email}>`);
  for (const c of d.changed) lines.push(`~ ${c.name}: ${c.fields.join(', ')}`);
  if (d.recipientsChanged) lines.push('~ Recipients tab changed');
  if (d.taskTypes.added.length) lines.push(`+ task types: ${d.taskTypes.added.join(', ')}`);
  if (d.taskTypes.removed.length) lines.push(`- task types: ${d.taskTypes.removed.join(', ')}`);
  if (d.taskTypes.recategorized.length) {
    lines.push(`~ task types recategorized: ${d.taskTypes.recategorized.join(', ')}`);
  }
  if (d.holidaysChanged) lines.push('~ Holidays changed');
  if (lines.length === 0) lines.push('No changes.');
  return lines;
}
