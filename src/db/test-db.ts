/** An in-process Postgres (PGlite) with the real migrations applied. Tests only. */
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

import type { Db } from './client';
import * as schema from './schema';

export async function testDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: path.resolve(import.meta.dirname, '..', '..', 'migrations'),
  });
  return { db: db as unknown as Db, close: () => client.close() };
}
