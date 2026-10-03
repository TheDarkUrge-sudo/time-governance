import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Store } from '../db/store';
import { testDb } from '../db/test-db';
import type { OutboundEmail } from '../email/sendgrid';
import type { DeliveryContext } from './deliver';
import { alertMissedRuns, expectedRuns, findMissedRuns } from './watchdog';

const TZ = 'America/New_York';
// Tue Sep 29 2026, 10:30 EDT (UTC−4).
const TUE_1030 = new Date('2026-09-29T14:30:00Z');

describe('expected runs', () => {
  it('each job’s latest 9:00 slot at least an hour old, and the period it covers', () => {
    expect(expectedRuns(TUE_1030, TZ)).toEqual([
      { job: 'tuesday', period: '2026-09-21', scheduledOn: '2026-09-29' },
      { job: 'friday', period: '2026-09-14', scheduledOn: '2026-09-25' },
      { job: 'monthly', period: '2026-08', scheduledOn: '2026-09-14' },
    ]);
  });

  it('within the hour after a slot, that slot is not expected yet', () => {
    const tue0945 = new Date('2026-09-29T13:45:00Z');
    expect(expectedRuns(tue0945, TZ)[0]).toEqual({
      job: 'tuesday',
      period: '2026-09-14',
      scheduledOn: '2026-09-22',
    });
  });

  it('uses firm-local time across daylight saving (EST in December)', () => {
    const tue1005Est = new Date('2026-12-01T15:05:00Z');
    expect(expectedRuns(tue1005Est, TZ)[0]).toMatchObject({ scheduledOn: '2026-12-01' });
    const tue0955Est = new Date('2026-12-01T14:55:00Z'); // 9:55 EST — not yet an hour past
    expect(expectedRuns(tue0955Est, TZ)[0]).toMatchObject({ scheduledOn: '2026-11-24' });
  });
});

describe('missed runs (PGlite)', () => {
  let store: Store;
  let close: () => Promise<void>;
  beforeEach(async () => {
    const t = await testDb();
    store = new Store(t.db);
    close = t.close;
  });
  afterEach(async () => close());

  const run = async (
    job: 'tuesday' | 'friday' | 'monthly',
    period: string,
    outcome?: { status: 'ok' | 'failed'; error?: string },
  ) => {
    const id = await store.startRun(job, period);
    if (outcome) await store.finishRun(id, outcome);
  };

  it('watches a job only once it has run before (no alerts on a first deploy)', async () => {
    expect(await findMissedRuns(store, TUE_1030, TZ)).toEqual([]);
  });

  it('reports a slot with no record, a failure, and a run that never finished', async () => {
    await run('tuesday', '2026-09-14', { status: 'ok' });
    await run('friday', '2026-09-07', { status: 'ok' });
    await run('friday', '2026-09-14', {
      status: 'failed',
      error: 'KarbonUnavailableError: HTTP 503',
    });
    await run('monthly', '2026-07', { status: 'ok' });
    await run('monthly', '2026-08'); // still 'running' — the worker stopped mid-run

    const missed = await findMissedRuns(store, TUE_1030, TZ);
    expect(missed.map((m) => [m.job, m.period, m.last])).toEqual([
      ['tuesday', '2026-09-21', null],
      ['friday', '2026-09-14', { status: 'failed', error: 'KarbonUnavailableError: HTTP 503' }],
      ['monthly', '2026-08', { status: 'running', error: null }],
    ]);

    await run('tuesday', '2026-09-21', { status: 'ok' }); // re-run by hand
    expect((await findMissedRuns(store, TUE_1030, TZ)).map((m) => m.job)).toEqual([
      'friday',
      'monthly',
    ]);
  });

  it('emails the admin once per missed run, with the command to run it', async () => {
    await run('tuesday', '2026-09-14', { status: 'ok' });
    const sent: OutboundEmail[] = [];
    const ctx: DeliveryContext = {
      mode: 'live',
      shadowTo: null,
      store,
      dryRun: false,
      outDir: null,
      transport: (msg) => {
        sent.push(msg);
        return Promise.resolve({ messageId: `m${sent.length}` });
      },
    };
    const missed = await findMissedRuns(store, TUE_1030, TZ);
    const first = await alertMissedRuns(ctx, ['ops@hfacpas.com'], missed);
    expect(first.map((r) => r.outcome)).toEqual(['sent']);
    expect(sent[0]!.to).toEqual(['ops@hfacpas.com']);
    expect(sent[0]!.subject).toBe('Missed run: Tuesday review, week of Sep 21');
    expect(sent[0]!.text).toContain('pnpm tg run tuesday --week 2026-09-21');
    expect(sent[0]!.text).toContain('no record of it running');

    // The next hourly check finds it still missed, but doesn't email again.
    const again = await alertMissedRuns(ctx, ['ops@hfacpas.com'], missed);
    expect(again.map((r) => r.outcome)).toEqual(['already_sent']);
    expect(sent).toHaveLength(1);
  });
});
