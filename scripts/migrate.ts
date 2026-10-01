/** Applies committed migrations. Runs on every start (`pnpm start`). */
import path from 'node:path';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { connect } from '../src/db/client';

const { db, close } = connect();
try {
  await migrate(db as Parameters<typeof migrate>[0], {
    migrationsFolder: path.resolve(import.meta.dirname, '..', 'migrations'),
  });
  console.log('Migrations applied.');
} finally {
  await close();
}
