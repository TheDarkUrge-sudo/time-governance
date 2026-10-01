import { describe, expect, it } from 'vitest';

import { KarbonApiError, KarbonClient } from './client';
import { resolveInternalClients } from './internal-client';

const client = (found: boolean) =>
  new KarbonClient({
    sleep: () => Promise.resolve(),
    transport: () =>
      found
        ? Promise.resolve({ OrganizationKey: 'K-HFA', FullName: 'HFA Internal' })
        : Promise.reject(new KarbonApiError('404', 404)),
  });

describe('resolveInternalClients', () => {
  it('resolves 99999 to its Karbon key', async () => {
    const r = await resolveInternalClients(client(true), ['99999'], []);
    expect([...r.keys]).toEqual(['K-HFA']);
    expect(r.notes).toEqual([]);
    expect(r.resolved).toEqual(['99999 → HFA Internal (Organization K-HFA)']);
  });

  it('reports an ID Karbon does not know, and says when no internal client is set', async () => {
    const r = await resolveInternalClients(client(false), ['99999'], []);
    expect(r.keys.size).toBe(0);
    expect(r.notes[0]).toContain('No Karbon client has the ID 99999');
    expect(r.notes[1]).toContain('No internal client is set');
  });

  it('keeps directly configured keys alongside the lookup', async () => {
    const r = await resolveInternalClients(client(false), ['99999'], ['K-EXTRA']);
    expect([...r.keys]).toEqual(['K-EXTRA']);
    expect(r.notes).toHaveLength(1);
  });
});
