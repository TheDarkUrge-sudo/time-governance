import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  connect,
  ForeignDatabaseError,
  holdLocalDatabase,
  isLocalDatabase,
  migrateDatabase,
} from './client';
import { Store } from './store';

describe('laptop mode: local database (pglite:)', () => {
  let dir: string;
  let url: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tg-local-'));
    url = `pglite:${dir}`;
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it('is recognised by its prefix', () => {
    expect(isLocalDatabase(url)).toBe(true);
    expect(isLocalDatabase('postgres://x')).toBe(false);
    expect(isLocalDatabase(undefined)).toBe(false);
  });

  it('migrates, and keeps its data in the folder between runs', async () => {
    await migrateDatabase(url);
    const first = connect(url);
    const id = await new Store(first.db).startRun('tuesday', '2026-09-21');
    await new Store(first.db).finishRun(id, { status: 'ok' });
    await first.close();

    const again = connect(url);
    expect((await new Store(again.db).lastRun('tuesday', '2026-09-21'))?.status).toBe('ok');
    await again.close();
  });

  it("refuses another app's database before writing anything to it", async () => {
    // Another app's tables (as in Clarity's production database).
    const other = connect(url);
    await other.db.execute(sql`create table invoices (id int)`);
    await other.close();
    await expect(migrateDatabase(url)).rejects.toThrow(ForeignDatabaseError);
    const after = connect(url);
    const ours = await after.db.execute(sql`select to_regclass('public.job_runs') as t`);
    await after.close();
    expect((ours as { rows: { t: unknown }[] }).rows[0]?.t).toBeNull(); // nothing created
  });

  it("refuses a database whose migration history is another app's", async () => {
    const other = connect(url);
    await other.db.execute(sql`create schema drizzle`);
    await other.db.execute(
      sql`create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`,
    );
    await other.db.execute(
      sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('not-ours', 1)`,
    );
    await other.close();
    await expect(migrateDatabase(url)).rejects.toThrow("migration history isn't ours");
  });

  it('re-migrating its own database is fine', async () => {
    await migrateDatabase(url);
    await migrateDatabase(url);
  });

  /** Tries to open the folder from a second process; returns what it reported. */
  function openFromAnotherProcess(): string {
    const script = `import('./src/db/client.ts').then(async (m) => {
      try { const c = m.connect(${JSON.stringify(url)}); await c.close(); console.log('opened'); }
      catch (e) { console.log(e.name); }
    })`;
    return execFileSync(process.execPath, ['--import', 'tsx', '-e', script], {
      cwd: path.resolve(import.meta.dirname, '..', '..'),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: '' },
    }).trim();
  }

  it('lets one process use it at a time', async () => {
    await migrateDatabase(url);
    const holder = connect(url);
    expect(openFromAnotherProcess()).toBe('DatabaseInUseError');
    // In this process too: one open client at a time.
    expect(() => connect(url)).toThrow('already open in this process');
    await holder.close();
    expect(openFromAnotherProcess()).toBe('opened');
  });

  it('`run due` can hold it across its jobs; others wait until it lets go', async () => {
    await migrateDatabase(url);
    const release = holdLocalDatabase(dir);
    const job = connect(url); // the same process may use it while holding
    await job.close();
    expect(openFromAnotherProcess()).toBe('DatabaseInUseError'); // still held between jobs
    release();
    expect(openFromAnotherProcess()).toBe('opened');
  });

  it('clears a lock left by a crashed process, or from before a reboot', async () => {
    await migrateDatabase(url);
    const lock = path.join(dir, '.tg-lock');
    await writeFile(lock, '2147483646 0 crashed'); // a process that no longer exists
    await connect(url).close();
    await writeFile(lock, `${process.ppid} 1 before-reboot`); // a live PID, but another boot
    await connect(url).close();
  });
});
