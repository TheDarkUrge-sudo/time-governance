/**
 * A full simulated run with FICTIONAL staff: the real Tuesday, Friday and
 * monthly jobs against a fake Karbon and an in-process database, in live mode
 * with a capturing mail transport (nothing is sent anywhere). Three weeks run
 * in sequence so the Friday "weeks flagged" history has something to count.
 *
 * Usage: pnpm demo   → out/demo/*.html
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { datesIn, weekOf } from '../src/calendar';
import { Store } from '../src/db/store';
import { testDb } from '../src/db/test-db';
import type { Roster, RosterMember } from '../src/domain';
import type { OutboundEmail } from '../src/email/sendgrid';
import { escalationTotals, exportYear, findPeople, timeline } from '../src/history/history';
import type { JobDeps } from '../src/jobs/context';
import { runFriday } from '../src/jobs/friday';
import { runMonthly } from '../src/jobs/monthly';
import { runTuesday } from '../src/jobs/tuesday';
import { KarbonClient } from '../src/karbon/client';
import { GovernanceClients } from '../src/karbon/governance-notes';
import { DEFAULT_POLICY } from '../src/policy';

const HFA = 'C-HFA';
const CLIENTS = [
  ['C-ACME', 'Acme Manufacturing'],
  ['C-BETA', 'Beta Dental Group'],
  ['C-CEDAR', 'Cedar Partners LLC'],
  ['C-DUNE', 'Dune Logistics'],
] as const;

const person = (
  name: string,
  department: string,
  csaSlot: string,
  manager: 'dana' | 'sam',
  over: Partial<RosterMember> = {},
): RosterMember => ({
  name,
  email: `${name.split(' ')[0]!.charAt(0)}${name.split(' ')[1]}`.toLowerCase() + '@example.com',
  department,
  managerName: manager === 'dana' ? 'Dana Ferris' : 'Sam Patel',
  managerEmail: manager === 'dana' ? 'dferris@example.com' : 'spatel@example.com',
  csaSlot,
  active: true,
  utilizationTarget: 0.8,
  expectedWeeklyHours: null,
  excluded: false,
  hireDate: null,
  ...over,
});

const members = [
  person('Jordan Alvarez', 'Audit', 'CSA-1', 'dana'),
  person('Riley Chen', 'Tax', 'CSA-1', 'dana'),
  person('Taylor Brooks', 'Audit', 'CSA-1', 'dana'),
  person('Avery Kim', 'Audit', 'CSA-1', 'dana'),
  person('Jamie Ortiz', 'Tax', 'CSA-1', 'dana'),
  person('Chris Vale', 'Audit', 'CSA-1', 'dana'), // email has no Karbon user
  person('Morgan Okafor', 'Bookkeeping', 'CSA-2', 'sam'),
  person('Sam Nguyen', 'Advisory', 'CSA-2', 'sam'),
  person('Kai Diallo', 'Tax', 'CSA-2', 'sam'),
  person('Quinn Foster', 'Bookkeeping', 'CSA-2', 'sam', { expectedWeeklyHours: 24 }),
  person('Pat Morrison', 'Admin', '', 'dana', {
    excluded: true,
    csaSlot: null,
    managerEmail: null,
  }),
];

const roster: Roster = {
  members,
  recipients: [
    {
      role: 'csa',
      slot: 'CSA-1',
      name: 'Casey Morgan',
      email: 'cmorgan@example.com',
      karbonClientId: 'TG-CSA1',
    },
    {
      role: 'csa',
      slot: 'CSA-2',
      name: 'Robin Hayes',
      email: 'rhayes@example.com',
      karbonClientId: 'TG-CSA2',
    },
    {
      role: 'partner',
      slot: null,
      name: 'Pat Morrison',
      email: 'pmorrison@example.com',
      karbonClientId: 'TG-PARTNERS',
    },
    {
      role: 'partner',
      slot: null,
      name: 'Lee Grant',
      email: 'lgrant@example.com',
      karbonClientId: 'TG-PARTNERS',
    },
    // Manager rows only link a manager to their Governance client.
    {
      role: 'manager',
      slot: null,
      name: 'Dana Ferris',
      email: 'dferris@example.com',
      karbonClientId: 'TG-DANA',
    },
    {
      role: 'manager',
      slot: null,
      name: 'Sam Patel',
      email: 'spatel@example.com',
      karbonClientId: 'TG-SAM',
    },
  ],
  taskTypes: new Map([
    ['audit fieldwork', 'billable'],
    ['tax return prep', 'billable'],
    ['bookkeeping', 'billable'],
    ['advisory', 'billable'],
    ['admin', 'non_billable'],
    ['training', 'non_billable'],
    ['pto', 'pto'],
    ['sick', 'sick'],
  ]),
  holidays: [{ date: '2026-09-07', name: 'Labor Day' }],
};

const karbonId = (m: RosterMember) => `k-${m.email.split('@')[0]}`;
const users = [
  ...members
    .filter((m) => m.name !== 'Chris Vale')
    .map((m) => ({ Id: karbonId(m), Name: m.name, EmailAddress: m.email })),
  { Id: 'k-temp', Name: 'Temp Contractor', EmailAddress: 'temp.contractor@example.com' },
];
const capacity: Record<string, number | null> = Object.fromEntries(
  members.map((m) => [karbonId(m), m.expectedWeeklyHours ? m.expectedWeeklyHours * 60 : 2400]),
);
capacity[karbonId(members[8]!)] = null; // Kai Diallo: no capacity set in Karbon

/* ── Time entries ─────────────────────────────────────────────────────────── */

type Raw = Record<string, unknown>;
let seq = 0;
const holidays = new Set(roster.holidays.map((h) => h.date));
const taskFor: Record<string, string> = {
  Audit: 'Audit Fieldwork',
  Tax: 'Tax Return Prep',
  Bookkeeping: 'Bookkeeping',
  Advisory: 'Advisory',
};
function e(m: RosterMember, date: string, hours: number, over: Raw = {}): Raw {
  const [clientKey] = CLIENTS[(seq + date.charCodeAt(9)) % CLIENTS.length]!;
  return {
    IndividualTimeEntryKey: `e${++seq}`,
    UserKey: karbonId(m),
    Date: `${date}T00:00:00Z`,
    Minutes: Math.round(hours * 60),
    ClientKey: clientKey,
    WorkItemKey: `W-${clientKey}-1`,
    RoleName: 'Staff',
    TaskTypeName: taskFor[m.department] ?? 'Admin',
    Description: 'Client work per engagement plan',
    ...over,
  };
}
const weekdays = (monday: string) =>
  datesIn(weekOf(monday)).filter((d) => {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    return wd >= 1 && wd <= 5 && !holidays.has(d);
  });
/** A clean day: mostly billable client work plus a little admin on the internal client. */
function cleanWeek(m: RosterMember, monday: string): Raw[] {
  const perDay = (m.expectedWeeklyHours ?? 40) / 5;
  return weekdays(monday).flatMap((d) => [
    e(m, d, perDay - 1),
    e(m, d, 1, {
      ClientKey: HFA,
      WorkItemKey: 'W-HFA',
      TaskTypeName: 'Admin',
      Description: 'Weekly Karbon triage and inbox',
    }),
  ]);
}

/** What each person has logged by Tuesday, and what they add by Friday. */
function week(monday: string): { tuesday: Raw[]; friday: Raw[] } {
  const tuesday: Raw[] = [];
  const friday: Raw[] = [];
  const last = monday === '2026-09-21';
  const days = weekdays(monday);
  for (const m of members) {
    if (m.excluded || m.name === 'Chris Vale') continue;
    switch (m.name) {
      case 'Riley Chen': // minimal every week, never catches up
        tuesday.push(
          e(m, days[0]!, monday === '2026-09-07' ? 12 : monday === '2026-09-14' ? 10 : 3.5),
        );
        break;
      case 'Jordan Alvarez': // nothing in the last week, still nothing by Friday
        if (!last) tuesday.push(...cleanWeek(m, monday));
        break;
      case 'Jamie Ortiz': // late in the last week, but caught up by Friday
        if (last) {
          tuesday.push(e(m, days[0]!, 6));
          friday.push(...cleanWeek(m, monday).slice(2));
        } else tuesday.push(...cleanWeek(m, monday));
        break;
      case 'Kai Diallo': // a little ad hoc on the same client every week → recurring
        tuesday.push(
          ...cleanWeek(m, monday),
          e(m, days[1]!, 2, {
            ClientKey: 'C-ACME',
            WorkItemKey: 'W-ADHOC-ACME',
            Description: 'Quick question from controller',
          }),
        );
        break;
      case 'Morgan Okafor':
        tuesday.push(...cleanWeek(m, monday));
        if (last) {
          tuesday.push(
            e(m, days[2]!, 6, {
              ClientKey: 'C-CEDAR',
              RoleName: 'Admin (Internal Only)',
              TaskTypeName: 'Bookkeeping',
            }),
            e(m, days[3]!, 3, {
              ClientKey: HFA,
              WorkItemKey: 'W-HFA',
              TaskTypeName: 'Marketing Event',
              Description: 'Chamber breakfast',
            }),
          );
        }
        break;
      case 'Taylor Brooks':
        tuesday.push(...cleanWeek(m, monday));
        if (last)
          tuesday.push(
            e(m, days[1]!, 2, {
              ClientKey: HFA,
              WorkItemKey: 'W-HFA',
              TaskTypeName: 'Audit Fieldwork',
            }),
          );
        break;
      case 'Sam Nguyen':
        tuesday.push(...cleanWeek(m, monday));
        if (last) {
          tuesday.push(
            e(m, days[1]!, 2, { TaskTypeName: 'Admin', Description: '' }),
            e(m, days[2]!, 1.5, { TaskTypeName: 'Admin', Description: 'call' }),
            e(m, days[3]!, 1, { TaskTypeName: 'Training', Description: null }),
          );
        }
        break;
      case 'Avery Kim': // a PTO day in the last week, otherwise clean
        if (last)
          tuesday.push(
            ...cleanWeek(m, monday).slice(2),
            e(m, days[0]!, 8, {
              ClientKey: HFA,
              WorkItemKey: 'W-HFA',
              TaskTypeName: 'PTO',
              Description: 'PTO',
            }),
          );
        else tuesday.push(...cleanWeek(m, monday));
        break;
      default:
        tuesday.push(...cleanWeek(m, monday));
    }
  }
  tuesday.push(e({ ...members[0]!, email: 'temp@x' }, days[0]!, 6, { UserKey: 'k-temp' }));
  return { tuesday, friday };
}

/* ── Fake Karbon ──────────────────────────────────────────────────────────── */

const state = {
  entries: [] as Raw[],
  notes: [] as { id: string; label: string; body: Record<string, unknown> }[],
  comments: {} as Record<
    string,
    { CommentBody: string; CreatedDate: string; AuthorEmailAddress: string }[]
  >,
};
const karbon = new KarbonClient({
  sleep: () => Promise.resolve(),
  transport: (p, init) => {
    const q = decodeURIComponent(p);
    if (init) {
      const id = `note-${state.notes.length + 1}`;
      state.notes.push({ id, label, body: init.body as Record<string, unknown> });
      return Promise.resolve({ Id: id });
    }
    if (q.startsWith('/v3/Notes/')) {
      const id = q.slice('/v3/Notes/'.length);
      return Promise.resolve({ Id: id, Comments: state.comments[id] ?? [] });
    }
    // Every governance client in the demo is a Hidden "Governance" organization.
    const udi = /GetOrganizationByUserDefinedIdentifier\(UserDefinedIdentifier='([^']+)'\)/.exec(q);
    if (udi) {
      return Promise.resolve({
        OrganizationKey: `K-${udi[1]}`,
        FullName: `Time Governance – ${udi[1]}`,
        RestrictionLevel: 'Hidden',
        ContactType: 'Governance',
      });
    }
    if (q.startsWith('/v3/Users?')) return Promise.resolve({ value: users });
    if (q.startsWith('/v3/Users/')) {
      const id = q.slice('/v3/Users/'.length);
      return Promise.resolve({ Id: id, CapacityMinutesPerWeek: capacity[id] ?? null });
    }
    if (q.startsWith('/v3/WorkItems')) {
      return Promise.resolve({
        value: CLIENTS.map(([key, name]) => ({
          WorkItemKey: `W-ADHOC-${key.slice(2)}`,
          Title: 'Ad Hoc',
          ClientKey: key,
          ClientName: name,
        })),
      });
    }
    if (q.startsWith('/v3/IndividualTimeEntries')) {
      const [, from, to] = /Date ge (\S+)T.* Date lt (\S+)T/.exec(q)!;
      const skip = Number(/\$skip=(\d+)/.exec(q)![1]);
      const rows = state.entries.filter((r) => {
        const d = String(r.Date).slice(0, 10);
        return d >= from! && d < to!;
      });
      return Promise.resolve({ value: rows.slice(skip, skip + 1000) });
    }
    return Promise.reject(new Error(`unexpected ${q}`));
  },
});

/* ── Run ──────────────────────────────────────────────────────────────────── */

const out = path.resolve(import.meta.dirname, '..', 'out', 'demo');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const { db, close } = await testDb();
const store = new Store(db);
await store.replaceRoster(roster, { fileName: 'demo.xlsx', changes: [], warnings: [] });

const captured: { label: string; msg: OutboundEmail }[] = [];
let label = '';
const deps: JobDeps = {
  karbon,
  store,
  roster,
  policy: DEFAULT_POLICY,
  delivery: {
    mode: 'live',
    shadowTo: null,
    store,
    dryRun: false,
    outDir: null,
    transport: (msg) => {
      captured.push({ label, msg });
      return Promise.resolve({ messageId: `demo-${captured.length}` });
    },
  },
  adminTo: ['ops@example.com'],
  internalClientKeys: new Set([HFA]),
  adHocTitle: 'Ad Hoc',
  retentionDays: 400,
  setupNotes: [],
  notes: {
    mode: 'live',
    author: 'coo@example.com',
    requiredClientType: 'Governance',
    shadowClientId: null,
    shadowAssignee: null,
    dryRun: false,
    outDir: null,
  },
  governance: new GovernanceClients(karbon, 'Governance'),
};

const weeks = ['2026-09-07', '2026-09-14', '2026-09-21'];
const all: Raw[] = [];
for (const monday of weeks) {
  const w = week(monday);
  state.entries = [...all, ...w.tuesday];
  label = `${monday}-1-tuesday`;
  await runTuesday(deps, weekOf(monday));
  state.entries.push(...w.friday);
  if (monday === '2026-09-21') {
    // Casey follows up with Riley and records it on Riley's Karbon note.
    const rileyNote = state.notes.find(
      (n) => n.label === `${monday}-1-tuesday` && String(n.body.Subject).includes('Riley Chen'),
    )!;
    state.comments[rileyNote.id] = [
      {
        CommentBody:
          'Spoke to Riley Tuesday. Behind after the 9/15 deadlines; entering the rest by Thursday.',
        CreatedDate: '2026-09-29T15:20:00Z',
        AuthorEmailAddress: 'cmorgan@example.com',
      },
    ];
  }
  label = `${monday}-2-friday`;
  await runFriday(deps, weekOf(monday));
  all.push(...w.tuesday, ...w.friday);
}
// All of August (the trend's comparison month) and the rest of September, all clean.
for (const monday of [
  '2026-08-03',
  '2026-08-10',
  '2026-08-17',
  '2026-08-24',
  '2026-08-31',
  '2026-09-28',
]) {
  for (const m of members)
    if (!m.excluded && m.name !== 'Chris Vale') all.push(...cleanWeek(m, monday));
}
state.entries = all;
label = '2026-09-monthly';
await runMonthly(deps, '2026-09');

for (const [i, { label: l, msg }] of captured.entries()) {
  const slug = msg.subject
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/-+$/, '')
    .toLowerCase()
    .slice(0, 60);
  const name = `${String(i + 1).padStart(2, '0')}-${l}-${slug}`;
  await writeFile(path.join(out, `${name}.html`), msg.html);
  await writeFile(
    path.join(out, `${name}.txt`),
    `To: ${msg.to.join(', ')}\nSubject: ${msg.subject}\n\n${msg.text}`,
  );
  console.log(`${name}\n    to ${msg.to.join(', ')}`);
}
// The Karbon governance notes, as HTML previews.
for (const [i, n] of state.notes.entries()) {
  const b = n.body as {
    Subject: string;
    Body: string;
    AuthorEmailAddress: string;
    AssigneeEmailAddress?: string;
    DueDate?: string;
    Timelines: { EntityKey: string }[];
  };
  const name = `note-${String(i + 1).padStart(2, '0')}-${n.label}-${b.Subject.replace(
    /[^a-z0-9]+/gi,
    '-',
  )
    .toLowerCase()
    .slice(0, 50)}.html`;
  const timeline = b.Timelines[0]!.EntityKey;
  await writeFile(
    path.join(out, name),
    `<!doctype html><meta charset="utf-8"><body style="font:13px Arial;max-width:640px;margin:24px">
<p style="color:#666;font-size:12px">Karbon note on ${timeline.replace('K-', '')} · by ${b.AuthorEmailAddress}${b.AssigneeEmailAddress ? ` · assigned to ${b.AssigneeEmailAddress}` : ''}${b.DueDate ? ` · due ${b.DueDate.slice(0, 10)}` : ''}</p>
<h3>${b.Subject}</h3>${b.Body}</body>`,
  );
}
console.log(`\n${state.notes.length} Karbon notes posted (fake Karbon)`);

// What `pnpm tg history riley` and `pnpm tg history --export 2026` produce.
const [riley] = await findPeople(store, roster, 'riley');
const esc = await store.escalationHistory({ email: riley!.email });
const totals = escalationTotals(esc, '2026-10-01', 4);
const lines = timeline(await store.weeklyHistory({ email: riley!.email }), esc);
const historyText = [
  `${riley!.name} <${riley!.email}> — ${riley!.department}, manager ${riley!.managerName}`,
  `Escalated to Partners: ${totals.recent} in the last 4 weeks · ${totals.thisYear} this year · ${totals.allTime} all time`,
  '',
  ...lines.map(
    (l) =>
      `${l.weekStart}  ${(l.hoursLogged ?? 0).toFixed(1).padStart(5)} h  ${l.escalated ? 'escalated' : '         '}  ${l.details.join('; ') || '—'}`,
  ),
].join('\n');
await writeFile(path.join(out, 'history-riley.txt'), historyText);
await writeFile(path.join(out, 'history-2026.xlsx'), await exportYear(store, roster, '2026'));
console.log(`\n${historyText}`);

await close();
console.log(
  `\n${captured.length} emails, a history lookup and a 2026 export → ${out} (nothing was sent)`,
);
