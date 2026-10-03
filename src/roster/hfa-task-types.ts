/**
 * HFA's Karbon task types and how each counts (owner, 2026-10-03), pre-filled
 * on the template's Task Types tab. Billability follows Karbon's own setting:
 * types Karbon marks Non-billable are non-billable here; the rest are billable.
 * Leave codes are PTO (Bereavement and Jury Duty count as time off, not work)
 * and "PTO - Sick" is Sick.
 *
 * Names are as Karbon shows them, without its "Non-billable" badge.
 * `pnpm tg karbon:task-types` confirms they match what the API returns —
 * any that don't are listed as MISSING there and in each Tuesday summary.
 */
export const HFA_TASK_TYPES: readonly (readonly [name: string, category: string])[] = [
  ['Administrative', 'Non-billable'],
  ['Advisory Services', 'Billable'],
  ['AUP Procedures', 'Billable'],
  ['Bereavement', 'PTO'],
  ['Bookkeeping', 'Billable'],
  ['Business Advisory', 'Billable'],
  ['Business Development/Marketing', 'Non-billable'],
  ['CAS - Accounting / Bookkeeping', 'Billable'],
  ['CAS - BPO - Back Office Process Outsourcing', 'Billable'],
  ['CAS - CFO Services', 'Billable'],
  ['CAS - Controllership Services', 'Billable'],
  ['CAS - Financial Planning & Analysis', 'Billable'],
  ['Client / Project Setup', 'Billable'],
  ['Client Meeting / Communication', 'Billable'],
  ['Client Training', 'Billable'],
  ['Committees - Fun Club', 'Non-billable'],
  ['Committees - Practice Dev', 'Non-billable'],
  ['Committees - Quality Control', 'Non-billable'],
  ['Committees - Technology', 'Non-billable'],
  ['Committees - Training & Dev', 'Non-billable'],
  ['Community Impact', 'Non-billable'],
  ['Compliance', 'Billable'],
  ['Down!', 'Non-billable'],
  ['Employee Engagement', 'Non-billable'],
  ['Fieldwork', 'Billable'],
  ['Financial Operations (Internal)', 'Non-billable'],
  ['Internal Meetings', 'Non-billable'],
  ['Jury Duty', 'PTO'],
  ['Non-Attest Work', 'Billable'],
  ['Personnel Development', 'Non-billable'],
  ['Planning', 'Billable'],
  ['Practice Development', 'Non-billable'],
  ['Processing', 'Billable'],
  ['Professional Development & Training', 'Non-billable'],
  ['PTO - Holiday', 'PTO'],
  ['PTO - Sick', 'Sick'],
  ['PTO - Vacation', 'PTO'],
  ['Report Preparation', 'Billable'],
  ['Research - Billable', 'Billable'],
  ['Review', 'Billable'],
  ['Tax Preparation', 'Billable'],
  ['Tax Review', 'Billable'],
  ['Training', 'Non-billable'],
  ['Travel', 'Non-billable'],
];
