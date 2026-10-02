import { describe, expect, it } from 'vitest';

import {
  KarbonApiError,
  KarbonClient,
  type KarbonTransport,
  KarbonUnavailableError,
  KarbonWriteUncertainError,
} from './client';

function fake(handler: (path: string) => unknown) {
  const calls: string[] = [];
  const transport: KarbonTransport = (path) => {
    calls.push(decodeURIComponent(path));
    return Promise.resolve().then(() => handler(decodeURIComponent(path)));
  };
  return { transport, calls, sleep: () => Promise.resolve() };
}

describe('KarbonClient', () => {
  it('pages users by 100 and drops duplicates', async () => {
    const all = Array.from({ length: 150 }, (_, i) => ({
      Id: `u${i}`,
      Name: ` User ${i} `,
      EmailAddress: `u${i}@hfacpas.com`,
    }));
    const f = fake((path) => {
      const skip = Number(/\$skip=(\d+)/.exec(path)![1]);
      return { value: all.slice(skip, skip + 100) };
    });
    const users = await new KarbonClient(f).listUsers();
    expect(users).toHaveLength(150);
    expect(users[0]).toEqual({ id: 'u0', name: 'User 0', email: 'u0@hfacpas.com' });
    expect(f.calls).toEqual(['/v3/Users?$top=100&$skip=0', '/v3/Users?$top=100&$skip=100']);
  });

  it('filters time entries by the date range and normalizes them', async () => {
    const f = fake(() => ({
      value: [
        {
          IndividualTimeEntryKey: 'a',
          UserKey: 'u1',
          Date: '2026-09-21T00:00:00Z',
          Minutes: 90,
          ClientKey: 'C1',
          WorkItemKey: 'W1',
          RoleName: 'Senior',
          TaskTypeName: 'Audit Fieldwork',
          Description: null,
          TimesheetKey: '4bLnlnsHm4pM',
          HourlyRate: 150,
        },
        {
          IndividualTimeEntryKey: 'a',
          UserKey: 'u1',
          Date: '2026-09-21T00:00:00Z',
          Minutes: 90,
        },
      ],
    }));
    const entries = await new KarbonClient(f).listTimeEntries({
      start: '2026-09-21',
      end: '2026-09-27',
    });
    expect(f.calls[0]).toBe(
      '/v3/IndividualTimeEntries?$filter=Date ge 2026-09-21T00:00:00Z and Date lt 2026-09-28T00:00:00Z&$top=1000&$skip=0',
    );
    expect(entries).toEqual([
      {
        key: 'a',
        userKey: 'u1',
        date: '2026-09-21',
        minutes: 90,
        clientKey: 'C1',
        workItemKey: 'W1',
        roleName: 'Senior',
        taskTypeName: 'Audit Fieldwork',
        description: null,
        timesheetKey: '4bLnlnsHm4pM',
      },
    ]);
  });

  it('finds ad hoc work items by title, escaping quotes, and keeps only real matches', async () => {
    const f = fake(() => ({
      value: [
        { WorkItemKey: 'W1', Title: 'Ad Hoc', ClientKey: 'C1', ClientName: 'Acme Corp' },
        { WorkItemKey: 'W2', Title: 'AD HOC - 2026', ClientKey: 'C2', ClientName: null },
        { WorkItemKey: 'W3', Title: 'Ad Hoc', ClientKey: null },
        { WorkItemKey: 'W4', Title: 'Tax Return', ClientKey: 'C4' },
      ],
    }));
    const items = await new KarbonClient(f).listAdHocWorkItems("Ad Hoc's");
    expect(f.calls[0]).toContain("contains(Title,'Ad Hoc''s')");
    expect(items).toEqual([]);
    const items2 = await new KarbonClient(f).listAdHocWorkItems('Ad Hoc');
    expect(items2).toEqual([
      { workItemKey: 'W1', clientKey: 'C1', clientName: 'Acme Corp' },
      { workItemKey: 'W2', clientKey: 'C2', clientName: null },
    ]);
  });

  it('reads per-user capacity', async () => {
    const f = fake(() => ({ Id: 'u1', CapacityMinutesPerWeek: 2400 }));
    expect(await new KarbonClient(f).getUserCapacityMinutes('u1')).toBe(2400);
    const g = fake(() => ({ Id: 'u1' }));
    expect(await new KarbonClient(g).getUserCapacityMinutes('u1')).toBeNull();
  });

  it('retries a 429 and then succeeds', async () => {
    let n = 0;
    const waits: number[] = [];
    const client = new KarbonClient({
      transport: () => {
        n += 1;
        if (n === 1) return Promise.reject(new KarbonUnavailableError('429', 7));
        return Promise.resolve({ value: [] });
      },
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(await client.listUsers()).toEqual([]);
    expect(waits).toEqual([7000]);
  });

  it('does not retry a definitive 4xx, and rejects an unexpected shape', async () => {
    let n = 0;
    const client = new KarbonClient({
      transport: () => {
        n += 1;
        return Promise.reject(new KarbonApiError('nope', 403));
      },
      sleep: () => Promise.resolve(),
    });
    await expect(client.listUsers()).rejects.toBeInstanceOf(KarbonApiError);
    expect(n).toBe(1);
    const bad = new KarbonClient(fake(() => ({ items: [] })));
    await expect(bad.listUsers()).rejects.toBeInstanceOf(KarbonUnavailableError);
  });

  it('finds the internal client by its client ID, trying each client type', async () => {
    const f = fake((path) => {
      if (path.includes('Organizations')) return Promise.reject(new KarbonApiError('404', 404));
      if (path.includes('Contacts'))
        return { ContactKey: 'K-99', FirstName: 'HFA', LastName: 'Internal' };
      throw new Error('should not reach client groups');
    });
    const found = await new KarbonClient(f).findClientByUserDefinedId('99999');
    expect(found).toEqual({
      clientKey: 'K-99',
      name: 'HFA Internal',
      type: 'Contact',
      restrictionLevel: null,
      clientType: null,
    });
    expect(f.calls[0]).toBe(
      "/v3/Organizations/GetOrganizationByUserDefinedIdentifier(UserDefinedIdentifier='99999')",
    );

    const org = fake(() => ({
      OrganizationKey: 'K-ORG',
      FullName: 'Holman Frenia Allison (internal)',
    }));
    expect(await new KarbonClient(org).findClientByUserDefinedId('99999')).toEqual({
      clientKey: 'K-ORG',
      name: 'Holman Frenia Allison (internal)',
      type: 'Organization',
      restrictionLevel: null,
      clientType: null,
    });

    const none = fake(() => Promise.reject(new KarbonApiError('404', 404)));
    expect(await new KarbonClient(none).findClientByUserDefinedId('99999')).toBeNull();
  });

  it('stops if Karbon ignores $skip', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ Id: `u${i}` }));
    const f = fake(() => ({ value: full }));
    const users = await new KarbonClient(f).listUsers();
    expect(users).toHaveLength(100);
    expect(f.calls).toHaveLength(2);
  });

  it('posts a note with assignee, due date and timeline, and reads comments back', async () => {
    const bodies: unknown[] = [];
    const client = new KarbonClient({
      sleep: () => Promise.resolve(),
      transport: (path, init) => {
        if (init) {
          bodies.push(init.body);
          return Promise.resolve({ Id: 'N1' });
        }
        expect(path).toBe('/v3/Notes/N1');
        return Promise.resolve({
          Id: 'N1',
          Comments: [
            {
              CommentBody: 'second',
              CreatedDate: '2026-09-24T10:00:00Z',
              AuthorEmailAddress: 'c@x.com',
            },
            { CommentBody: '  ', CreatedDate: '2026-09-23T10:00:00Z' },
            {
              CommentBody: 'first',
              CreatedDate: '2026-09-22T10:00:00Z',
              AuthorEmailAddress: 'c@x.com',
            },
          ],
        });
      },
    });
    const id = await client.postNote({
      subject: 'S',
      bodyHtml: '<p>B</p>',
      authorEmail: 'coo@x.com',
      assigneeEmail: 'csa@x.com',
      dueDate: '2026-09-25',
      timeline: { entityType: 'Organization', entityKey: 'K-GOV' },
    });
    expect(id).toBe('N1');
    expect(bodies[0]).toEqual({
      Subject: 'S',
      Body: '<p>B</p>',
      AuthorEmailAddress: 'coo@x.com',
      AssigneeEmailAddress: 'csa@x.com',
      DueDate: '2026-09-25T00:00:00Z',
      Timelines: [{ EntityType: 'Organization', EntityKey: 'K-GOV' }],
    });
    expect((await client.getNoteComments('N1')).map((c) => c.body)).toEqual(['first', 'second']);
  });

  it('retries a note only on 429; a network failure is uncertain, a 4xx is definitive', async () => {
    const run = (fail: Error) => {
      let n = 0;
      const client = new KarbonClient({
        sleep: () => Promise.resolve(),
        transport: () => {
          n += 1;
          return n === 1 ? Promise.reject(fail) : Promise.resolve({ Id: 'N2' });
        },
      });
      const note = {
        subject: 'S',
        bodyHtml: 'B',
        authorEmail: 'a@x.com',
        assigneeEmail: null,
        dueDate: null,
        timeline: { entityType: 'Organization' as const, entityKey: 'K' },
      };
      return { promise: client.postNote(note), calls: () => n };
    };
    const limited = run(new KarbonUnavailableError('429', 1, true));
    expect(await limited.promise).toBe('N2');
    expect(limited.calls()).toBe(2);

    const reset = run(new KarbonUnavailableError('network'));
    await expect(reset.promise).rejects.toBeInstanceOf(KarbonWriteUncertainError);
    expect(reset.calls()).toBe(1);

    const refused = run(new KarbonApiError('forbidden', 403));
    await expect(refused.promise).rejects.toBeInstanceOf(KarbonApiError);
  });
});
