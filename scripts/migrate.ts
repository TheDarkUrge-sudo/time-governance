/** Applies committed migrations. Runs on every start (`pnpm start`); works for the laptop database too. */
import { migrateDatabase } from '../src/db/client';

await migrateDatabase();
console.log('Migrations applied.');
