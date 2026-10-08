import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { getTableName, is, type SQL, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { type PgDatabase, type PgQueryResultHKT, PgTable } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';

import { env } from '../env';
import * as schema from './schema';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super('DATABASE_URL is not set.');
    this.name = 'DatabaseNotConfiguredError';
  }
}

export class DatabaseInUseError extends Error {
  constructor(pid: number) {
    super(
      `The local database is in use by another tg command (process ${pid}). Wait for it to finish, then try again.`,
    );
    this.name = 'DatabaseInUseError';
  }
}

/**
 * Laptop mode: `DATABASE_URL=pglite:./data` keeps the database in a folder —
 * an embedded Postgres (PGlite), nothing to install. One process at a time:
 * two opening the same folder corrupt it, so a lock file guards it. Within one
 * process the lock is shared, so `tg run due` can hold it across its jobs.
 */
const LOCAL_PREFIX = 'pglite:';

export function isLocalDatabase(url = env.DATABASE_URL): boolean {
  return Boolean(url?.startsWith(LOCAL_PREFIX));
}

/** The folder a `pglite:` URL points at (relative paths from the current directory). */
export function localDatabaseDir(url: string): string {
  return path.resolve(url.slice(LOCAL_PREFIX.length) || './data');
}

let localClientOpen = false;

const MIGRATIONS = path.resolve(import.meta.dirname, '..', '..', 'migrations');

export function connect(url = env.DATABASE_URL): { db: Db; close: () => Promise<void> } {
  if (!url) throw new DatabaseNotConfiguredError();
  if (isLocalDatabase(url)) {
    // One open client at a time, in this process too (the lock is shared
    // within a process so `tg run due` can hold it between its jobs).
    if (localClientOpen) throw new Error('The local database is already open in this process.');
    const dir = localDatabaseDir(url);
    const release = holdLocalDatabase(dir);
    const client = new PGlite(dir);
    localClientOpen = true;
    return {
      db: drizzlePglite(client, { schema }),
      close: async () => {
        try {
          await client.close();
        } finally {
          localClientOpen = false;
          release();
        }
      },
    };
  }
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}

export class ForeignDatabaseError extends Error {
  constructor(detail: string) {
    super(
      `DATABASE_URL points at a database another app already uses (${detail}). Time governance needs its own database — on a laptop, DATABASE_URL=pglite:./data. Nothing was changed.`,
    );
    this.name = 'ForeignDatabaseError';
  }
}

/**
 * Refuses a database that belongs to another app (e.g. Clarity's) before
 * writing anything to it: tables that aren't ours, or a drizzle migration
 * journal holding another app's migrations. Sharing one would mix staff data
 * into that app's database, and our migration rows would move its journal's
 * watermark — so that app would skip its own migrations.
 */
async function assertOwnDatabase(db: Db): Promise<void> {
  const ours = new Set<string>(
    Object.values(schema)
      .filter((t) => is(t, PgTable))
      .map((t) => getTableName(t)),
  );
  const tables = await rows<{ name: string }>(
    db,
    sql`select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  const foreign = tables.map((r) => r.name).filter((n) => !ours.has(n));
  if (foreign.length > 0) {
    throw new ForeignDatabaseError(`it has other tables: ${foreign.slice(0, 5).join(', ')}`);
  }
  const journal = await rows<{ present: boolean }>(
    db,
    sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`,
  );
  if (!journal[0]?.present) return;
  const applied = await rows<{ hash: string }>(
    db,
    sql`select hash from drizzle.__drizzle_migrations`,
  );
  const known = new Set(ourMigrationHashes());
  if (applied.some((r) => !known.has(r.hash))) {
    throw new ForeignDatabaseError("its migration history isn't ours");
  }
}

/** A raw query's rows — both drivers (node-postgres, PGlite) return `{ rows }`. */
async function rows<T>(db: Db, query: SQL): Promise<T[]> {
  return ((await db.execute(query)) as { rows: T[] }).rows;
}

/** sha256 of each committed migration file — exactly what drizzle records per applied migration. */
function ourMigrationHashes(): string[] {
  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8'),
  ) as {
    entries: { tag: string }[];
  };
  return journal.entries.map((e) =>
    createHash('sha256')
      .update(readFileSync(path.join(MIGRATIONS, `${e.tag}.sql`), 'utf8'))
      .digest('hex'),
  );
}

/** Applies the committed migrations — to Postgres, or to the laptop's local database. */
export async function migrateDatabase(url = env.DATABASE_URL): Promise<void> {
  const { db, close } = connect(url);
  try {
    await assertOwnDatabase(db);
    if (isLocalDatabase(url)) {
      await migratePglite(db as unknown as Parameters<typeof migratePglite>[0], {
        migrationsFolder: MIGRATIONS,
      });
    } else {
      await migratePg(db as Parameters<typeof migratePg>[0], { migrationsFolder: MIGRATIONS });
    }
  } finally {
    await close();
  }
}

/* ── The folder lock ─────────────────────────────────────────────────────── */

/** When this machine last booted (to the minute) — a lock from before a reboot is stale. */
const BOOT_ID = String(Math.round((Date.now() - os.uptime() * 1000) / 60_000));

/** The lock this process holds, shared by its connections (counted). */
let held: { dir: string; count: number; release: () => void } | null = null;

/**
 * Takes the local database's lock for this process (or shares the one it
 * already holds) and returns the release. Throws DatabaseInUseError while
 * another live process holds it.
 */
export function holdLocalDatabase(dir: string): () => void {
  if (held && held.dir === dir) {
    held.count++;
  } else {
    if (held) throw new Error('This process already has a different local database open.');
    held = { dir, count: 1, release: acquire(dir) };
  }
  let done = false;
  return () => {
    if (done || !held) return;
    done = true;
    if (--held.count === 0) {
      held.release();
      held = null;
    }
  };
}

function acquire(dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.tg-lock');
  const mine = `${process.pid} ${BOOT_ID} ${randomUUID()}`;
  // Write the content first, then link it into place: the lock never exists
  // half-written, and link fails atomically if another process holds it.
  const draft = `${file}.${process.pid}.${randomUUID()}`;
  writeFileSync(draft, mine);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(draft, file);
        return releaser(file, mine);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const current = readLock(file);
      if (current === null) continue; // released meanwhile — try again
      const [pid, boot] = current.split(' ');
      const live = boot === BOOT_ID && isAlive(Number(pid));
      if (live) throw new DatabaseInUseError(Number(pid));
      takeOverStale(file, current);
    }
  } finally {
    rmSync(draft, { force: true });
  }
  throw new Error(`Could not lock the local database folder ${dir}.`);
}

/**
 * Moves a stale lock aside. If another process replaced it in the meantime
 * (its fresh lock got moved instead), it is put back and the folder is in use.
 */
function takeOverStale(file: string, stale: string): void {
  const aside = `${file}.stale.${randomUUID()}`;
  try {
    renameSync(file, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // someone else moved it
    throw err;
  }
  const moved = readLock(aside);
  if (moved !== null && moved !== stale) {
    try {
      linkSync(aside, file);
    } catch {
      // another process already holds a new lock; either way it's in use
    }
    rmSync(aside, { force: true });
    throw new DatabaseInUseError(Number(moved.split(' ')[0]));
  }
  rmSync(aside, { force: true });
}

function releaser(file: string, mine: string): () => void {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off('exit', release);
    process.off('SIGINT', onSignal);
    if (readLock(file) === mine) rmSync(file, { force: true });
  };
  // Ctrl+C doesn't run 'exit' handlers by default — release, then stop.
  const onSignal = () => {
    release();
    process.exit(130);
  };
  process.on('exit', release);
  process.once('SIGINT', onSignal);
  return release;
}

function readLock(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function isAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
