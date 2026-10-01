/** Writes templates/HFA_Staff_Roster_Template.xlsx. Usage: pnpm template */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildTemplateWorkbook } from '../src/roster/template';

const out = path.resolve(import.meta.dirname, '..', 'templates', 'HFA_Staff_Roster_Template.xlsx');
await writeFile(out, await buildTemplateWorkbook());
console.log(`Wrote ${out}`);
