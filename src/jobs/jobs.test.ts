import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/client';
import { Store } from '../db/store';
import { testDb } from '../db/test-db';
import type { Roster } from '../domain';
import { EmailSendError, type OutboundEmail } from '../email/sendgrid';
import { KarbonClient } from '../karbon/client';
import { NOTES_OFF } from '../karbon/governance-notes';
import { DEFAULT_POLICY } from '../policy';
import { member, TASK_TYPES } from '../test-fixtures';
import type { JobDeps } from './context';
import type { Mode } from './deliver';
import { runFriday } from './friday';
import { runMonthly } from './monthly';
import { runTuesday } from './tuesday';

const WEEK = { start: '2026-09-21', end: '2026-09-27' };
const DAYS = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'];

const alvarez = member({ name: 'Jordan Alvarez', csaSlot: 'CSA-1' });
const chen = member({ name: 'Riley Chen', department: 'Tax', csaSlot: 'CSA-1' });
const okafor = member({
  name: 'Morgan Okafor',
  department: 'Bookkeeping',
  csaSlot: 'CSA-2',
  managerName: 'Sam Patel',
  managerEmail: 'spatel@hfacpas.com',
});

const ROSTER: Roster = {
  members: [alvarez, chen, okafor],
  recipients: [
    {
      role: 'csa',
      slot: 'CSA-1',
      name: 'Casey CSA',
      email: 'ccsa@hfacpas.com',
      karbonClientId: null,
    },
    {
      role: 'csa',
      slot: 'CSA-2',
      name: 'Drew CSA',
      email: 'dcsa@hfacpas.com',
      karbonClientId: null,
    },
    {
      role: 'partner',
      slot: null,
      name: 'Pat Partner',
      email: 'ppartner@hfacpas.com',
      karbonClientId: null,
    },
    {
      role: 'partner',
      slot: null,
      name: 'Lee Partner',
      email: 'lpartner@hfacpas.com',
      karbonClientId: null,
    },
  ],
  taskTypes: TASK_TYPES,
  holidays: [],
};

const USERS = [
  { Id: 'k-alvarez', Name: 'Jordan Alvarez', EmailAddress: alvarez.email },
  { Id: 'k-chen', Name: 'Riley Chen', EmailAddress: chen.email },
  { Id: 'k-okafor', Name: 'Morgan Okafor', EmailAddress: okafor.email },
  { Id: 'k-stray', Name: 'Stray Person', EmailAddress: 'stray@hfacpas.com' },
];

type RawEntry = Record<string, unknown>;
let n = 0;
const raw = (user: string, date: string, minutes: number, over: RawEntry = {}): RawEntry => ({
  IndividualTimeEntryKey: `e${++n}`,
  UserKey: user,
  Date: `${date}T00:00:00Z`,
  Minutes: minutes,
  ClientKey: 'C-ACME',
  WorkItemKey: 'W-1',
  RoleName: 'Staff',
  TaskTypeName: 'Audit Fieldwork',
  Description: 'Fieldwork on revenue testing',
  ...over,
});

/** A fake Karbon that serves whatever `entries` holds at call time. */
function fakeKarbon(state: { entries: RawEntry[]; capacity?: Record<string, number> }) {
  return new KarbonClient({
    sleep: () => Promise.resolve(),
    transport: (p) => {
      const pathOnly = decodeURIComponent(p);
      if (pathOnly.startsWith('/v3/Users?')) return Promise.resolve({ value: USERS });
      if (pathOnly.startsWith('/v3/Users/')) {
        const id = pathOnly.slice('/v3/Users/'.length);
        return Promise.resolve({ Id: id, CapacityMinutesPerWeek: state.capacity?.[id] ?? null });
      }
      if (pathOnly.startsWith('/v3/WorkItems')) {
        return Promise.resolve({
          value: [
            {
              WorkItemKey: 'W-ADHOC',
              Title: 'Ad Hoc',
              ClientKey: 'C-ACME',
              ClientName: 'Acme Corp',
            },
          ],
        });
      }
      if (pathOnly.startsWith('/v3/IndividualTimeEntries')) {
        const m = /Date ge (\S+)T.* Date lt (\S+)T/.exec(pathOnly)!;
        const skip = Number(/\$skip=(\d+)/.exec(pathOnly)![1]);
        const rows = state.entries.filter((e) => {
          const d = String(e.Date).slice(0, 10);
          return d >= m[1]! && d < m[2]!;
        });
        return Promise.resolve({ value: skip === 0 ? rows : [] });
      }
      return Promise.reject(new Error(`unexpected path ${pathOnly}`));
    },
  });
}

describe('jobs (PGlite + fake Karbon + fake SendGrid)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let store: Store;
  let sent: OutboundEmail[];
  let failNext: boolean;

  beforeEach(async () => {
    ({ db, close } = await testDb());
    store = new Store(db);
    await store.replaceRoster(ROSTER, { fileName: 'test.xlsx', changes: [], warnings: [] });
    sent = [];
    failNext = false;
  });
  afterEach(async () => close());

  function deps(
    state: { entries: RawEntry[] },
    mode: Mode = 'shadow',
    over: Partial<JobDeps> = {},
  ): JobDeps {
    return {
      karbon: fakeKarbon(state),
      store,
      roster: ROSTER,
      policy: DEFAULT_POLICY,
      delivery: {
        mode,
        shadowTo: 'coo@hfacpas.com',
        store,
        dryRun: false,
        outDir: null,
        transport: (msg) => {
          if (failNext) {
            failNext = false;
            return Promise.reject(
              new EmailSendError('SendGrid rejected the email (HTTP 500)', 500),
            );
          }
          sent.push(msg);
          return Promise.resolve({ messageId: `m${sent.length}` });
        },
      },
      adminTo: ['ops@hfacpas.com'],
      internalClientKeys: new Set(['C-HFA']),
      adHocTitle: 'Ad Hoc',
      retentionDays: 400,
      setupNotes: [],
      notes: NOTES_OFF,
      governance: null,
      ...over,
    };
  }

  const tuesdayEntries = () => [
    raw('k-chen', '2026-09-21', 210),
    ...DAYS.map((d) => raw('k-okafor', d, 480)),
    raw('k-okafor', '2026-09-22', 300, { WorkItemKey: 'W-ADHOC' }),
    raw('k-stray', '2026-09-22', 120),
  ];

  it('Tuesday in shadow mode: every email goes to the shadow address, once', async () => {
    const state = { entries: tuesdayEntries() };
    const result = await runTuesday(deps(state), WEEK);

    expect(sent.map((m) => [m.to, m.subject])).toEqual([
      [['coo@hfacpas.com'], '[Shadow] Weekly time entry review: week of Sep 21 — 2 flags'],
      [['coo@hfacpas.com'], '[Shadow] Weekly time entry review: week of Sep 21 — 1 flag'],
      [['coo@hfacpas.com'], '[Shadow] Tuesday review run: week of Sep 21'],
    ]);
    expect(sent[0]!.html).toContain('in live mode this email goes to: ccsa@hfacpas.com');
    expect(sent[0]!.html).toContain('#BA2025');
    expect(sent[0]!.html).not.toContain('#8B1A1A');
    expect(sent[1]!.text).toContain("5.0 h on Acme Corp's Ad Hoc work item");
    expect(sent[2]!.text).toContain('Stray Person (stray@hfacpas.com) — 2.0 h');
    expect(result.summary).toMatchObject({ checked: 3, flags: 3 });

    // History saved for Friday and next week's ad hoc streaks.
    expect(await store.tuesdayMissing(WEEK.start)).toEqual(new Set([alvarez.email, chen.email]));
    const streak = await store.adHocStreaks('2026-09-28', 3);
    expect(streak('k-okafor', 'C-ACME')).toBe(1);

    // A re-run sends nothing new.
    sent = [];
    const again = await runTuesday(deps(state), WEEK);
    expect(sent).toEqual([]);
    expect(again.deliveries.map((d) => d.outcome)).toEqual([
      'already_sent',
      'already_sent',
      'already_sent',
    ]);
  });

  it('live mode sends to the real recipients; a failed send is released and retried', async () => {
    const state = { entries: tuesdayEntries() };
    failNext = true;
    const first = await runTuesday(deps(state, 'live'), WEEK);
    expect(first.deliveries.map((d) => d.outcome)).toEqual(['failed', 'sent', 'sent']);
    expect(sent.map((m) => m.to)).toEqual([['dcsa@hfacpas.com'], ['ops@hfacpas.com']]);

    sent = [];
    const second = await runTuesday(deps(state, 'live'), WEEK);
    expect(second.deliveries.map((d) => d.outcome)).toEqual([
      'sent',
      'already_sent',
      'already_sent',
    ]);
    expect(sent.map((m) => m.to)).toEqual([['ccsa@hfacpas.com']]);
  });

  it('an email SendGrid accepted is never released, and an unfinished claim is in doubt on re-run', async () => {
    const state = { entries: tuesdayEntries() };
    const markSent = store.markSent.bind(store);
    store.markSent = () => Promise.reject(new Error('connection lost'));
    const first = await runTuesday(deps(state, 'live'), WEEK);
    expect(first.deliveries.map((d) => d.outcome)).toEqual(['sent', 'sent', 'sent']);
    expect(first.deliveries[0]!.error).toContain('sent, but recording it failed');

    store.markSent = markSent;
    sent = [];
    const second = await runTuesday(deps(state, 'live'), WEEK);
    expect(sent).toEqual([]); // nothing goes out twice
    // The claims never reached 'sent', so the re-run doesn't claim they did.
    expect(second.deliveries.map((d) => d.outcome)).toEqual(['in_doubt', 'in_doubt', 'in_doubt']);
    expect(second.deliveries[0]!.error).toContain('earlier attempt was interrupted');
  });

  it('mode off sends nothing at all', async () => {
    const result = await runTuesday(deps({ entries: tuesdayEntries() }, 'off'), WEEK);
    expect(sent).toEqual([]);
    expect(new Set(result.deliveries.map((d) => d.outcome))).toEqual(new Set(['mode_off']));
  });

  it('Friday escalates only Tuesday-flagged people still missing, with their history', async () => {
    const state = { entries: tuesdayEntries() };
    await runTuesday(deps(state, 'live'), WEEK);
    // Alvarez was escalated two weeks ago too.
    await store.saveEscalations('2026-09-07', [{ email: alvarez.email, kind: 'no_entry' }]);
    // …and once back in March, which only the year-to-date count sees.
    await store.saveEscalations('2026-03-02', [{ email: alvarez.email, kind: 'no_entry' }]);
    // By Friday Chen has caught up; Alvarez has not.
    state.entries.push(...DAYS.map((d) => raw('k-chen', d, 480)));
    sent = [];

    const result = await runFriday(deps(state, 'live'), WEEK);
    expect(result.summary).toMatchObject({ escalated: 1, tuesdayRan: true });
    const partnerEmail = sent.find((m) => m.subject.startsWith('Time entry still outstanding'))!;
    expect(partnerEmail.to).toEqual(['ppartner@hfacpas.com', 'lpartner@hfacpas.com']);
    expect(partnerEmail.subject).toBe('Time entry still outstanding: week of Sep 21 — 1 person');
    expect(partnerEmail.text).toContain('Jordan Alvarez');
    expect(partnerEmail.text).not.toContain('Riley Chen');
    expect(partnerEmail.text).toContain('flagged 2 of the last 4 weeks (3 this year)');
    expect(partnerEmail.html).toContain('3 this year');
    expect(partnerEmail.html).toContain('2 of last 4');
    expect(await store.priorEscalationCounts('2026-09-28', 4)).toEqual(
      new Map([[alvarez.email, 2]]),
    );
  });

  it('Friday with nobody left sends only the admin summary', async () => {
    const state = { entries: DAYS.flatMap((d) => USERS.slice(0, 3).map((u) => raw(u.Id, d, 480))) };
    await runTuesday(deps(state, 'live'), WEEK);
    sent = [];
    await runFriday(deps(state, 'live'), WEEK);
    expect(sent.map((m) => m.subject)).toEqual(['Friday escalation run: week of Sep 21']);
    expect(sent[0]!.text).toContain('Nobody to escalate');
  });

  it('monthly: one report per manager, with Karbon capacity', async () => {
    const state = {
      entries: [
        raw('k-alvarez', '2026-09-02', 100 * 60),
        raw('k-chen', '2026-09-03', 150 * 60),
        raw('k-okafor', '2026-09-04', 120 * 60),
        raw('k-alvarez', '2026-08-05', 120 * 60), // August: 120 of 168 h → 71%
      ],
      capacity: { 'k-alvarez': 2400 },
    };
    const result = await runMonthly(deps(state, 'live'), '2026-09');
    const reports = sent.filter((m) => m.subject === 'September 2026 utilization report');
    expect(reports.map((m) => m.to)).toEqual([['dferris@hfacpas.com'], ['spatel@hfacpas.com']]);
    expect(reports[0]!.text).toContain('Jordan Alvarez (Audit): billable 100.0h');
    expect(reports[0]!.text).toMatch(/Jordan Alvarez.*capacity 176\.0h, utilization 57%/);
    expect(reports[0]!.text).toContain(
      'Jordan Alvarez is 23 points under target, down 14 from August.',
    );
    // Riley Chen logged nothing in August: no comparison, rather than "up 85".
    expect(reports[0]!.text).toMatch(/Riley Chen .*utilization 85% \(target 80%\)\n/);
    expect(result.summary).toMatchObject({ people: 3, managers: 2 });
  });

  it('dry run writes previews and touches neither the database nor SendGrid', async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), 'tg-'));
    const d = deps({ entries: tuesdayEntries() }, 'live');
    d.store = null;
    d.delivery = { ...d.delivery, dryRun: true, store: null, outDir };
    await runTuesday(d, WEEK);
    expect(sent).toEqual([]);
    expect(await store.recentRuns()).toEqual([]);
    const files = (await readdir(outDir)).sort();
    expect(files).toEqual([
      'admin_summary--admin_tuesday.html',
      'admin_summary--admin_tuesday.txt',
      'csa_weekly--csa_CSA-1.html',
      'csa_weekly--csa_CSA-1.txt',
      'csa_weekly--csa_CSA-2.html',
      'csa_weekly--csa_CSA-2.txt',
    ]);
    const txt = await readFile(path.join(outDir, 'csa_weekly--csa_CSA-1.txt'), 'utf8');
    expect(txt).toContain('To: ccsa@hfacpas.com');
    expect(txt).toContain('Jordan Alvarez (Audit): No entry');
  });

  it('ad hoc streaks skip weeks under the minimum', async () => {
    const usage = (minutes: number) => [
      { userKey: 'k1', email: 'a@x.com', clientKey: 'C1', minutes },
    ];
    await store.saveAdHocUsage('2026-09-07', usage(120));
    await store.saveAdHocUsage('2026-09-14', usage(30)); // under 1 h: breaks the streak
    const streak = await store.adHocStreaks('2026-09-21', 3, 60);
    expect(streak('k1', 'C1')).toBe(0);
    await store.saveAdHocUsage('2026-09-14', usage(60));
    expect((await store.adHocStreaks('2026-09-21', 3, 60))('k1', 'C1')).toBe(2);
  });

  it('purges history older than the retention window on each Tuesday run', async () => {
    await store.saveEscalations('2025-01-06', [{ email: alvarez.email, kind: 'no_entry' }]);
    await store.saveEscalations('2026-09-07', [{ email: alvarez.email, kind: 'no_entry' }]);
    await runTuesday(deps({ entries: tuesdayEntries() }), WEEK);
    expect(await store.priorEscalationCounts('2026-10-05', 100)).toEqual(
      new Map([[alvarez.email, 1]]),
    );
  });

  it('records each run, including a failure', async () => {
    const d = deps({ entries: [] });
    d.karbon = new KarbonClient({
      transport: () => Promise.reject(new Error('boom')),
      sleep: () => Promise.resolve(),
    });
    await expect(runTuesday(d, WEEK)).rejects.toThrow('boom');
    const [run] = await store.recentRuns();
    expect(run).toMatchObject({ job: 'tuesday', period: '2026-09-21', status: 'failed' });
  });
});
