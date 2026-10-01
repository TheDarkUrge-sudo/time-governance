# CLAUDE.md

HFA Time Governance — a standalone worker that runs the firm's Time
Governance SOP from Karbon's API and emails CSAs (Tuesday), Partners (Friday)
and Managers (monthly). Read `README.md`, then `docs/decisions.md` before
changing a rule, and `docs/operations.md` before changing anything an
operator relies on. Update those docs in the same commit as the change.

## Commands

pnpm only (npm/yarn are rejected). Supply-chain guard: new package versions
must be ≥ 1 day old (`pnpm-workspace.yaml` — do not disable).

```sh
pnpm check            # format:check → typecheck → lint → test (CI order)
pnpm exec vitest run src/checks/weekly.test.ts
pnpm tg <command>     # the CLI (src/cli.ts)
pnpm db:generate      # after any src/db/schema.ts change — commit the generated SQL; never hand-write it
```

Tests need no services: Karbon and SendGrid go through fake transports, the
database is in-process PGlite with the real migrations (`src/db/test-db.ts`).

## Layout

- `src/checks/` — **pure** rule engines (weekly checks, Friday escalation,
  monthly utilization). No I/O; every rule is unit-tested here.
- `src/karbon/client.ts` — the only Karbon I/O. Read-only. Zod-parses every
  payload; retries 429/5xx; never echoes response bodies.
- `src/roster/` — workbook template, strict parser (any problem rejects the
  file), diff.
- `src/email/` — renderers return `{subject, bodyHtml, text}`; `layout.ts`
  owns the shell. `sendgrid.ts` is the only mail I/O.
- `src/jobs/` — Tuesday / Friday / monthly orchestration; `deliver.ts` applies
  the mode (off/shadow/live), claims each send, writes dry-run previews.
- `src/db/` — Drizzle schema, `Store` (all SQL), migrations in `migrations/`.
- `src/worker.ts` — node-cron schedules in `FIRM_TIMEZONE`. `src/cli.ts` — the CLI.
- `scripts/demo.ts` (`pnpm demo`) — the real jobs over three weeks of fictional
  staff against a fake Karbon; emails land in `out/demo`. Re-run it after any
  email or rule change to see the result.

## Rules

- Minutes are integers until the render edge; dates are firm-local
  `YYYY-MM-DD` strings (`src/calendar.ts` — never derive a local date from
  `toISOString()`).
- Server-side zod imports use `zod/v4`.
- Every string from the roster or Karbon is escaped in emails (`escapeHtml`).
- Brand: `#BA2025` only in the email top bar; tables use the charcoal header;
  status reds are tinted, never a solid fill. Never `#8B1A1A`.
- Nothing sends twice: every email goes through `deliver()` and its claim.
- `out/` holds real staff data from dry runs — never commit it.
