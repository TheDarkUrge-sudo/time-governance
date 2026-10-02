import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/client';
import { Store } from '../db/store';
import { testDb } from '../db/test-db';
import type { Roster } from '../domain';
import type { OutboundEmail } from '../email/sendgrid';
import { KarbonApiError, KarbonClient, KarbonUnavailableError } from '../karbon/client';
import { GovernanceClients, type NotesContext } from '../karbon/governance-notes';
import { DEFAULT_POLICY } from '../policy';
import { member, TASK_TYPES } from '../test-fixtures';
import type { JobDeps } from './context';
import { runFriday } from './friday';
import { runMonthly } from './monthly';
import { runTuesday } from './tuesday';

const WEEK = { start: '2026-09-21', end: '2026-09-27' };
const DAYS = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'];

const alvarez = member({ name: 'Jordan Alvarez', csaSlot: 'CSA-1' });
const chen = member({ name: 'Riley Chen', department: 'Tax', csaSlot: 'CSA-1' });
const okafor = member({
  name: 'Morgan Okafor',
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
      karbonClientId: 'TG-CSA1',
    },
    {
      role: 'csa',
      slot: 'CSA-2',
      name: 'Drew CSA',
      email: 'dcsa@hfacpas.com',
      karbonClientId: 'TG-CSA2',
    },
    {
      role: 'partner',
      slot: null,
      name: 'Pat Partner',
      email: 'ppartner@hfacpas.com',
      karbonClientId: 'TG-PARTNERS',
    },
    {
      role: 'manager',
      slot: null,
      name: 'Dana Ferris',
      email: 'dferris@hfacpas.com',
      karbonClientId: 'TG-DANA',
    },
  ],
  taskTypes: TASK_TYPES,
  holidays: [],
};

/** Governance clients by client ID: visibility and type as Karbon would report them. */
const CLIENTS: Record<string, { RestrictionLevel: string; ContactType: string }> = {
  'TG-CSA1': { RestrictionLevel: 'Hidden', ContactType: 'Governance' },
  'TG-CSA2': { RestrictionLevel: 'Public', ContactType: 'Governance' }, // misconfigured
  'TG-PARTNERS': { RestrictionLevel: 'Hidden', ContactType: 'Governance' },
  'TG-DANA': { RestrictionLevel: 'Hidden', ContactType: 'Governance' },
  'TG-SHADOW': { RestrictionLevel: 'Hidden', ContactType: 'Governance' },
  'TG-WRONGTYPE': { RestrictionLevel: 'Hidden', ContactType: 'Client' },
};

let n = 0;
const raw = (user: string, date: string, minutes: number, over: Record<string, unknown> = {}) => ({
  IndividualTimeEntryKey: `e${++n}`,
  UserKey: user,
  Date: `${date}T00:00:00Z`,
  Minutes: minutes,
  ClientKey: 'C-ACME',
  WorkItemKey: 'W-1',
  RoleName: 'Staff',
  TaskTypeName: 'Audit Fieldwork',
  Description: 'Fieldwork',
  ...over,
});

interface PostedNote {
  id: string;
  body: Record<string, unknown>;
}

function fakeKarbon(state: {
  entries: Record<string, unknown>[];
  posted: PostedNote[];
  comments: Record<
    string,
    { CommentBody: string; CreatedDate: string; AuthorEmailAddress: string }[]
  >;
  failPost?: Error;
}) {
  return new KarbonClient({
    sleep: () => Promise.resolve(),
    transport: (p, init) => {
      const q = decodeURIComponent(p);
      if (init) {
        if (state.failPost) return Promise.reject(state.failPost);
        const id = `N${state.posted.length + 1}`;
        state.posted.push({ id, body: init.body as Record<string, unknown> });
        return Promise.resolve({ Id: id });
      }
      if (q.startsWith('/v3/Notes/')) {
        const id = q.slice('/v3/Notes/'.length);
        return Promise.resolve({ Id: id, Comments: state.comments[id] ?? [] });
      }
      const lookup = /UserDefinedIdentifier='([^']+)'/.exec(q);
      if (lookup) {
        const c = CLIENTS[lookup[1]!];
        if (!c || !q.includes('Organizations'))
          return Promise.reject(new KarbonApiError('404', 404));
        return Promise.resolve({ OrganizationKey: `K-${lookup[1]}`, FullName: lookup[1], ...c });
      }
      if (q.startsWith('/v3/Users?')) {
        return Promise.resolve({
          value: [alvarez, chen, okafor].map((m) => ({
            Id: `k-${m.email}`,
            Name: m.name,
            EmailAddress: m.email,
          })),
        });
      }
      if (q.startsWith('/v3/Users/'))
        return Promise.resolve({ Id: 'x', CapacityMinutesPerWeek: 2400 });
      if (q.startsWith('/v3/WorkItems')) return Promise.resolve({ value: [] });
      if (q.startsWith('/v3/IndividualTimeEntries')) {
        const [, from, to] = /Date ge (\S+)T.* Date lt (\S+)T/.exec(q)!;
        const skip = Number(/\$skip=(\d+)/.exec(q)![1]);
        const rows = state.entries.filter((e) => {
          const d = String(e.Date).slice(0, 10);
          return d >= from! && d < to!;
        });
        return Promise.resolve({ value: skip === 0 ? rows : [] });
      }
      return Promise.reject(new Error(`unexpected ${q}`));
    },
  });
}

describe('Karbon governance notes', () => {
  let db: Db;
  let close: () => Promise<void>;
  let store: Store;
  let sent: OutboundEmail[];
  let state: Parameters<typeof fakeKarbon>[0];

  beforeEach(async () => {
    ({ db, close } = await testDb());
    store = new Store(db);
    await store.replaceRoster(ROSTER, { fileName: 't.xlsx', changes: [], warnings: [] });
    sent = [];
    state = {
      entries: [
        raw(`k-${chen.email}`, '2026-09-21', 210), // minimal
        ...DAYS.map((d) => raw(`k-${okafor.email}`, d, 480)),
        raw(`k-${okafor.email}`, '2026-09-22', 60, { ClientKey: 'C-HFA' }), // billable on internal
      ],
      posted: [],
      comments: {},
    };
  });
  afterEach(async () => close());

  function deps(notes: Partial<NotesContext> = {}, over: Partial<JobDeps> = {}): JobDeps {
    const karbon = fakeKarbon(state);
    return {
      karbon,
      store,
      roster: ROSTER,
      policy: DEFAULT_POLICY,
      delivery: {
        mode: 'live',
        shadowTo: null,
        store,
        dryRun: false,
        outDir: null,
        transport: (msg) => {
          sent.push(msg);
          return Promise.resolve({ messageId: `m${sent.length}` });
        },
      },
      adminTo: ['ops@hfacpas.com'],
      internalClientKeys: new Set(['C-HFA']),
      adHocTitle: 'Ad Hoc',
      retentionDays: 0,
      setupNotes: [],
      notes: {
        mode: 'live',
        author: 'coo@hfacpas.com',
        requiredClientType: 'Governance',
        shadowClientId: 'TG-SHADOW',
        shadowAssignee: 'coo@hfacpas.com',
        dryRun: false,
        outDir: null,
        ...notes,
      },
      governance: new GovernanceClients(karbon, notes.requiredClientType ?? 'Governance'),
      ...over,
    };
  }

  it('Tuesday: one note per flagged person on the CSA’s Hidden Governance client, due Friday', async () => {
    await runTuesday(deps(), WEEK);
    expect(state.posted.map((p) => p.body.Subject)).toEqual([
      'Time review: Jordan Alvarez — week of Sep 21',
      'Time review: Riley Chen — week of Sep 21',
    ]);
    expect(state.posted[0]!.body).toMatchObject({
      AuthorEmailAddress: 'coo@hfacpas.com',
      AssigneeEmailAddress: 'ccsa@hfacpas.com',
      DueDate: '2026-10-02T00:00:00Z', // the Friday of the review week
      Timelines: [{ EntityType: 'Organization', EntityKey: 'K-TG-CSA1' }],
    });
    expect(String(state.posted[1]!.body.Body)).toContain('3.5 h logged; expected at least 20.0 h');

    // CSA-2's client is Public, so Okafor's note is refused — and the admin summary says why.
    const admin = sent.find((m) => m.subject.startsWith('Tuesday review run'))!;
    expect(admin.text).toContain('refused');
    expect(admin.text).toContain('client TG-CSA2 is Public, not Hidden');

    // A re-run never posts twice.
    state.posted = [];
    await runTuesday(deps(), WEEK);
    expect(state.posted).toEqual([]);
  });

  it('refuses a Hidden client of the wrong type', async () => {
    const roster: Roster = {
      ...ROSTER,
      recipients: ROSTER.recipients.map((r) =>
        r.slot === 'CSA-1' ? { ...r, karbonClientId: 'TG-WRONGTYPE' } : r,
      ),
    };
    await runTuesday(deps({}, { roster }), WEEK);
    expect(state.posted).toEqual([]);
    const admin = sent.find((m) => m.subject.startsWith('Tuesday review run'))!;
    expect(admin.text).toContain('is type "Client", not "Governance"');
  });

  it('Friday: the CSA’s comments ride along in the Partner email and note', async () => {
    await runTuesday(deps(), WEEK);
    const chenNote = state.posted.find((p) => String(p.body.Subject).includes('Riley Chen'))!;
    state.comments[chenNote.id] = [
      {
        CommentBody: '<p>Spoke to Riley Tuesday — <b>entering by Thursday</b>.</p>',
        CreatedDate: '2026-09-29T15:00:00Z',
        AuthorEmailAddress: 'ccsa@hfacpas.com',
      },
    ];
    state.posted = [];
    sent = [];
    await runFriday(deps(), WEEK);

    const email = sent.find((m) => m.subject.startsWith('Time entry still outstanding'))!;
    expect(email.text).toContain('CSA follow-up (from Karbon):');
    expect(email.text).toContain(
      'Riley Chen: “Spoke to Riley Tuesday — entering by Thursday.” (ccsa, Sep 29)',
    );
    expect(email.html).not.toContain('<b>entering');

    expect(state.posted).toHaveLength(1);
    expect(state.posted[0]!.body).toMatchObject({
      Subject: 'Time entry still outstanding: week of Sep 21 — 2 people',
      Timelines: [{ EntityType: 'Organization', EntityKey: 'K-TG-PARTNERS' }],
    });
    expect(state.posted[0]!.body.AssigneeEmailAddress).toBeUndefined();
    expect(String(state.posted[0]!.body.Body)).toContain('CSA follow-up');
  });

  it('monthly: a note on each manager’s governance client; managers without one are skipped', async () => {
    await runMonthly(deps(), '2026-09');
    expect(state.posted.map((p) => [p.body.Subject, p.body.AssigneeEmailAddress])).toEqual([
      ['September 2026 utilization report', 'dferris@hfacpas.com'],
    ]);
    const admin = sent.find((m) => m.subject.startsWith('Monthly utilization run'))!;
    expect(admin.text).toContain('no_client');
  });

  it('shadow: every note goes to the shadow client, assigned to the shadow reviewer', async () => {
    await runTuesday(deps({ mode: 'shadow' }), WEEK);
    expect(state.posted).toHaveLength(2); // CSA-2's Public client is still refused
    for (const p of state.posted) {
      expect(String(p.body.Subject)).toMatch(/^\[Shadow\] /);
      expect(p.body.AssigneeEmailAddress).toBe('coo@hfacpas.com');
      expect(p.body.Timelines).toEqual([{ EntityType: 'Organization', EntityKey: 'K-TG-SHADOW' }]);
      expect(String(p.body.Body)).toContain(
        'in live mode this note goes to governance client TG-CSA1',
      );
    }
  });

  it('an interrupted post is left in doubt and never re-posted', async () => {
    state.failPost = new KarbonUnavailableError('socket hang up');
    await runTuesday(deps(), WEEK);
    const admin = sent.find((m) => m.subject.startsWith('Tuesday review run'))!;
    expect(admin.text).toContain('in_doubt');
    state.failPost = undefined;
    await runTuesday(deps(), WEEK);
    expect(state.posted).toEqual([]);
  });

  it('a note Karbon created is never re-posted, even if recording it fails', async () => {
    const mark = store.markNotePosted.bind(store);
    store.markNotePosted = () => Promise.reject(new Error('connection lost'));
    await runTuesday(deps(), WEEK);
    const posted = state.posted.length;
    expect(posted).toBeGreaterThan(0);

    store.markNotePosted = mark;
    const again = await runTuesday(deps(), WEEK);
    expect(state.posted).toHaveLength(posted); // nothing posted twice
    expect(JSON.stringify(again.admin)).toContain('earlier attempt was interrupted');
  });

  it('a failed governance-client lookup is retried by the next note, not cached', async () => {
    let calls = 0;
    const karbon = {
      findClientByUserDefinedId: () =>
        ++calls === 1
          ? Promise.reject(new KarbonUnavailableError('Karbon responded HTTP 503'))
          : Promise.resolve({
              clientKey: 'G1',
              name: 'Time Governance – CSA-1',
              type: 'Organization' as const,
              restrictionLevel: 'Hidden',
              clientType: 'Governance',
            }),
    } as unknown as KarbonClient;
    const clients = new GovernanceClients(karbon, 'Governance');
    await expect(clients.resolve('TG-CSA1')).rejects.toThrow('503');
    await expect(clients.resolve('TG-CSA1')).resolves.toMatchObject({ ok: true });
  });

  it('dry run: note previews, nothing posted, and a misconfigured client still refused', async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), 'tg-notes-'));
    const d = deps({ dryRun: true, outDir });
    d.store = null;
    d.delivery = { ...d.delivery, dryRun: true, store: null, outDir };
    await runTuesday(d, WEEK);
    expect(state.posted).toEqual([]);
    const previews = (await readdir(outDir)).filter((f) => f.startsWith('note--'));
    expect(previews).toHaveLength(2); // Okafor's goes to CSA-2's Public client: refused
    const admin = await readFile(path.join(outDir, 'admin_summary--admin_tuesday.txt'), 'utf8');
    expect(admin).toContain('client TG-CSA2 is Public, not Hidden');
    const chenPreview = await readFile(
      path.join(
        outDir,
        previews.find((f) => f.includes('riley.chen'))!,
      ),
      'utf8',
    );
    expect(chenPreview).toContain('assigned to ccsa@hfacpas.com, due 2026-10-02');
  });
});
