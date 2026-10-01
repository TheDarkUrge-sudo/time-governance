/**
 * Resolves the internal HFA client (by default client ID 99999) to the Karbon
 * keys that time entries carry. Never throws for a missing ID: the run goes on
 * and the admin summary says what couldn't be resolved.
 */
import type { KarbonClient } from './client';

export async function resolveInternalClients(
  karbon: KarbonClient,
  ids: readonly string[],
  extraKeys: readonly string[],
): Promise<{ keys: Set<string>; notes: string[]; resolved: string[] }> {
  const keys = new Set(extraKeys);
  const notes: string[] = [];
  const resolved: string[] = [];
  for (const id of ids) {
    const found = await karbon.findClientByUserDefinedId(id);
    if (found) {
      keys.add(found.clientKey);
      resolved.push(`${id} → ${found.name ?? 'unnamed'} (${found.type} ${found.clientKey})`);
    } else {
      notes.push(
        `No Karbon client has the ID ${id}, so it can't be treated as the internal client. Check KARBON_INTERNAL_CLIENT_IDS.`,
      );
    }
  }
  if (keys.size === 0) {
    notes.push(
      'No internal client is set: check 1 (billable time on the internal client) cannot run, and checks 2–4 treat it like a real client.',
    );
  }
  return { keys, notes, resolved };
}
