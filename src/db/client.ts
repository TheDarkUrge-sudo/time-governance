import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
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

export function connect(url = env.DATABASE_URL): { db: Db; close: () => Promise<void> } {
  if (!url) throw new DatabaseNotConfiguredError();
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}
