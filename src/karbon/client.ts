/**
 * Karbon API client — the only place this app talks to Karbon. Read-only.
 *
 * Endpoints (contract: Karbon v3, the same `KarbonAPIspec.json` Clarity pins):
 *   GET /v3/Users                    every user (paged by 100)
 *   GET /v3/Users/{id}               one user, with CapacityMinutesPerWeek
 *   GET /v3/IndividualTimeEntries    one row per user × day × work item (paged by 1,000)
 *   GET /v3/WorkItems                filtered to each client's Ad Hoc work item (paged by 100)
 *   GET …ByUserDefinedIdentifier     a client by the firm's own client ID (99999, governance clients)
 *   POST /v3/Notes, GET /v3/Notes/{id}  governance notes and their comments (off unless enabled)
 *
 * Payloads are zod-parsed at this boundary; nothing past it trusts Karbon's
 * shape. A 429 or 5xx is retried a few times with backoff (honouring
 * Retry-After); a definitive 4xx is not.
 */
import { z } from 'zod/v4';

import { addDays } from '../calendar';
import type { DateRange, KarbonUser, TimeEntry } from '../domain';
import { env } from '../env';
import { logger } from '../logger';

const BASE_URL = 'https://api.karbonhq.com';
const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;
const MAX_PAGES = 500;

/** Karbon is unreachable, rate-limiting, erroring, or answered in an unexpected shape. */
export class KarbonUnavailableError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
    /** True only for a 429: Karbon refused the request, so even a write is safe to retry. */
    readonly rateLimited = false,
  ) {
    super(message);
    this.name = 'KarbonUnavailableError';
  }
}

/** Karbon answered with a definitive 4xx (bad filter, bad key, no permission). */
export class KarbonApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'KarbonApiError';
  }
}

export class KarbonNotConfiguredError extends Error {
  constructor() {
    super('Karbon is not configured: set KARBON_API_KEY and KARBON_API_SECRET.');
    this.name = 'KarbonNotConfiguredError';
  }
}

/** One request; resolves to the parsed JSON body. GET unless `init` says POST. */
export type KarbonTransport = (
  path: string,
  init?: { method: 'POST'; body: unknown },
) => Promise<unknown>;

export function liveTransport(bearer: string, accessKey: string): KarbonTransport {
  return async (path, init) => {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method: init?.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${bearer}`,
          AccessKey: accessKey,
          ...(init ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new KarbonUnavailableError(
        `Karbon request failed (${err instanceof Error ? err.name : 'network error'})`,
      );
    }
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after'));
      throw new KarbonUnavailableError(
        'Karbon responded HTTP 429',
        Number.isFinite(retry) && retry >= 0 ? retry : undefined,
        true,
      );
    }
    if (res.status >= 500) throw new KarbonUnavailableError(`Karbon responded HTTP ${res.status}`);
    // Never echo the body: a 4xx can quote the request back, credentials included.
    if (!res.ok)
      throw new KarbonApiError(`Karbon rejected the request (HTTP ${res.status})`, res.status);
    try {
      return await res.json();
    } catch {
      throw new KarbonUnavailableError('Karbon returned a non-JSON body');
    }
  };
}

export function karbonConfigured(): boolean {
  return Boolean(env.KARBON_API_KEY && env.KARBON_API_SECRET);
}

/* ── Raw shapes ─────────────────────────────────────────────────────────── */

const page = <T extends z.ZodType>(row: T) =>
  z.object({ value: z.array(row), '@odata.nextLink': z.string().nullish() });

const rawUser = z.object({
  Id: z.string().min(1),
  Name: z.string().nullish(),
  EmailAddress: z.string().nullish(),
});

const rawUserDetail = rawUser.extend({
  CapacityMinutesPerWeek: z.number().nullish(),
});

const rawTimeEntry = z.object({
  IndividualTimeEntryKey: z.string().min(1),
  UserKey: z.string().min(1),
  Date: z.string().min(10),
  Minutes: z.number(),
  ClientKey: z.string().nullish(),
  WorkItemKey: z.string().nullish(),
  RoleName: z.string().nullish(),
  TaskTypeName: z.string().nullish(),
  Description: z.string().nullish(),
  TimesheetKey: z.string().nullish(),
});

const rawWorkItem = z.object({
  WorkItemKey: z.string().min(1),
  Title: z.string().nullish(),
  ClientKey: z.string().nullish(),
  ClientName: z.string().nullish(),
});

export interface KarbonClientRef {
  clientKey: string;
  name: string | null;
  type: 'Organization' | 'Contact' | 'ClientGroup';
  /** Public | Private | Hidden — only Hidden clients may hold governance notes. */
  restrictionLevel: string | null;
  /** The firm's client type (e.g. "Internal", "Governance"). */
  clientType: string | null;
}

/** A write whose outcome is unknown (timeout, reset, 5xx): it may or may not have landed. */
export class KarbonWriteUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KarbonWriteUncertainError';
  }
}

export interface NoteComment {
  author: string | null;
  createdAt: string | null;
  body: string;
}

const rawNote = z.object({
  Id: z.string().nullish(),
  Comments: z
    .array(
      z.object({
        CommentBody: z.string().nullish(),
        CreatedDate: z.string().nullish(),
        AuthorEmailAddress: z.string().nullish(),
      }),
    )
    .nullish(),
});

const LOOKUPS = [
  {
    type: 'Organization',
    path: 'Organizations/GetOrganizationByUserDefinedIdentifier',
    schema: z.object({
      OrganizationKey: z.string().min(1),
      FullName: z.string().nullish(),
      RestrictionLevel: z.string().nullish(),
      ContactType: z.string().nullish(),
    }),
    key: (r: Record<string, unknown>) => r.OrganizationKey as string,
  },
  {
    type: 'Contact',
    path: 'Contacts/GetContactByUserDefinedIdentifier',
    schema: z.object({
      ContactKey: z.string().min(1),
      FirstName: z.string().nullish(),
      LastName: z.string().nullish(),
      RestrictionLevel: z.string().nullish(),
      ContactType: z.string().nullish(),
    }),
    key: (r: Record<string, unknown>) => r.ContactKey as string,
  },
  {
    type: 'ClientGroup',
    path: 'ClientGroups/GetClientGroupByUserDefinedIdentifier',
    schema: z.object({
      ClientGroupKey: z.string().min(1),
      FullName: z.string().nullish(),
      RestrictionLevel: z.string().nullish(),
      ContactType: z.string().nullish(),
    }),
    key: (r: Record<string, unknown>) => r.ClientGroupKey as string,
  },
] as const;

export interface AdHocWorkItem {
  workItemKey: string;
  clientKey: string;
  clientName: string | null;
}

/** OData string literal: single quotes doubled. */
const odataString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/* ── Client ─────────────────────────────────────────────────────────────── */

export interface KarbonClientOptions {
  transport?: KarbonTransport;
  /** Injectable for tests (backoff waits). */
  sleep?: (ms: number) => Promise<void>;
}

export class KarbonClient {
  private readonly transport: KarbonTransport;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: KarbonClientOptions = {}) {
    if (opts.transport) {
      this.transport = opts.transport;
    } else {
      if (!env.KARBON_API_KEY || !env.KARBON_API_SECRET) throw new KarbonNotConfiguredError();
      this.transport = liveTransport(env.KARBON_API_KEY, env.KARBON_API_SECRET);
    }
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** GET with retry on 429 / 5xx / network. */
  private async get(path: string): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.transport(path);
      } catch (err) {
        if (!(err instanceof KarbonUnavailableError) || attempt >= MAX_ATTEMPTS) throw err;
        const waitMs = (err.retryAfterSeconds ?? 2 ** attempt) * 1000;
        logger.warn({ attempt, waitMs, reason: err.message }, 'karbon: retrying');
        await this.sleep(waitMs);
      }
    }
  }

  /** Every page of a list, by $top/$skip. Stops on a short page or a repeated page. */
  private async getAll<T extends z.ZodType>(
    path: string,
    row: T,
    pageSize: number,
    what: string,
  ): Promise<z.infer<T>[]> {
    const out: z.infer<T>[] = [];
    const sep = path.includes('?') ? '&' : '?';
    let previousFirst: string | null = null;
    for (let p = 0; p < MAX_PAGES; p++) {
      const payload = await this.get(`${path}${sep}$top=${pageSize}&$skip=${p * pageSize}`);
      const parsed = page(row).safeParse(payload);
      if (!parsed.success) {
        throw new KarbonUnavailableError(`Karbon ${what} did not match the expected shape`);
      }
      const rows = parsed.data.value;
      // Guard against an API that ignores $skip and serves the same page forever.
      const first = rows.length > 0 ? JSON.stringify(rows[0]) : null;
      if (first !== null && first === previousFirst) {
        logger.warn({ what, page: p }, 'karbon: a page repeated — treating the list as complete');
        return out;
      }
      previousFirst = first;
      out.push(...rows);
      if (rows.length < pageSize) return out;
    }
    throw new KarbonUnavailableError(`Karbon ${what} did not end within ${MAX_PAGES} pages`);
  }

  async listUsers(): Promise<KarbonUser[]> {
    const rows = await this.getAll('/v3/Users', rawUser, 100, '/v3/Users');
    const seen = new Set<string>();
    const users: KarbonUser[] = [];
    for (const u of rows) {
      if (seen.has(u.Id)) continue;
      seen.add(u.Id);
      users.push({ id: u.Id, name: u.Name?.trim() || null, email: u.EmailAddress?.trim() || null });
    }
    return users;
  }

  /** Weekly billable capacity in minutes; null when Karbon has none set. */
  async getUserCapacityMinutes(userId: string): Promise<number | null> {
    const payload = await this.get(`/v3/Users/${encodeURIComponent(userId)}`);
    const parsed = rawUserDetail.safeParse(payload);
    if (!parsed.success) {
      throw new KarbonUnavailableError('Karbon /v3/Users/{id} did not match the expected shape');
    }
    return parsed.data.CapacityMinutesPerWeek ?? null;
  }

  async listTimeEntries(range: DateRange): Promise<TimeEntry[]> {
    // `lt` the next midnight, not `le` the last one: an entry stamped later than
    // 00:00 on the final day must still be inside the range.
    const filter = `Date ge ${range.start}T00:00:00Z and Date lt ${addDays(range.end, 1)}T00:00:00Z`;
    const rows = await this.getAll(
      `/v3/IndividualTimeEntries?$filter=${encodeURIComponent(filter)}`,
      rawTimeEntry,
      1000,
      '/v3/IndividualTimeEntries',
    );
    const seen = new Set<string>();
    const out: TimeEntry[] = [];
    for (const r of rows) {
      if (seen.has(r.IndividualTimeEntryKey)) continue;
      seen.add(r.IndividualTimeEntryKey);
      out.push({
        key: r.IndividualTimeEntryKey,
        userKey: r.UserKey,
        date: r.Date.slice(0, 10),
        minutes: Math.max(0, Math.round(r.Minutes)),
        clientKey: r.ClientKey || null,
        workItemKey: r.WorkItemKey || null,
        roleName: r.RoleName ?? null,
        taskTypeName: r.TaskTypeName ?? null,
        description: r.Description ?? null,
        timesheetKey: r.TimesheetKey || null,
      });
    }
    return out;
  }

  /**
   * A client by the firm's own client ID (Karbon's UserDefinedIdentifier, e.g.
   * "99999" for the internal HFA client). Tries organizations, then contacts,
   * then client groups; null if none has that ID.
   */
  async findClientByUserDefinedId(id: string): Promise<KarbonClientRef | null> {
    const literal = encodeURIComponent(odataString(id));
    for (const lookup of LOOKUPS) {
      let payload: unknown;
      try {
        payload = await this.get(`/v3/${lookup.path}(UserDefinedIdentifier=${literal})`);
      } catch (err) {
        if (err instanceof KarbonApiError && err.status === 404) continue;
        throw err;
      }
      const parsed = lookup.schema.safeParse(payload);
      if (!parsed.success) {
        throw new KarbonUnavailableError(
          `Karbon ${lookup.type} lookup did not match the expected shape`,
        );
      }
      const r = parsed.data as Record<string, unknown>;
      const name =
        'FullName' in r
          ? ((r.FullName as string | null | undefined) ?? null)
          : [r.FirstName, r.LastName].filter(Boolean).join(' ') || null;
      return {
        clientKey: lookup.key(r),
        name,
        type: lookup.type,
        restrictionLevel: (r.RestrictionLevel as string | null | undefined) ?? null,
        clientType: (r.ContactType as string | null | undefined) ?? null,
      };
    }
    return null;
  }

  /**
   * Posts a note. Retried only on a 429 (Karbon refused it); a timeout, reset
   * or 5xx throws KarbonWriteUncertainError — the note may exist, and Karbon
   * notes cannot be deleted through the API, so it is never blindly re-posted.
   */
  async postNote(note: {
    subject: string;
    bodyHtml: string;
    authorEmail: string;
    assigneeEmail: string | null;
    dueDate: string | null;
    timeline: { entityType: KarbonClientRef['type']; entityKey: string };
  }): Promise<string> {
    const body = {
      Subject: note.subject,
      Body: note.bodyHtml,
      AuthorEmailAddress: note.authorEmail,
      ...(note.assigneeEmail ? { AssigneeEmailAddress: note.assigneeEmail } : {}),
      ...(note.dueDate ? { DueDate: `${note.dueDate}T00:00:00Z` } : {}),
      Timelines: [{ EntityType: note.timeline.entityType, EntityKey: note.timeline.entityKey }],
    };
    for (let attempt = 1; ; attempt++) {
      let payload: unknown;
      try {
        payload = await this.transport('/v3/Notes', { method: 'POST', body });
      } catch (err) {
        if (err instanceof KarbonUnavailableError && err.rateLimited && attempt < MAX_ATTEMPTS) {
          await this.sleep((err.retryAfterSeconds ?? 2 ** attempt) * 1000);
          continue;
        }
        if (err instanceof KarbonApiError) throw err; // definitive: nothing was created
        throw new KarbonWriteUncertainError(
          `Karbon note post did not complete (${err instanceof Error ? err.message : 'error'})`,
        );
      }
      const parsed = rawNote.safeParse(payload);
      if (!parsed.success || !parsed.data.Id) {
        throw new KarbonWriteUncertainError('Karbon accepted the note but returned no Id');
      }
      return parsed.data.Id;
    }
  }

  /** A note's comments, oldest first. */
  async getNoteComments(noteId: string): Promise<NoteComment[]> {
    const payload = await this.get(`/v3/Notes/${encodeURIComponent(noteId)}`);
    const parsed = rawNote.safeParse(payload);
    if (!parsed.success) {
      throw new KarbonUnavailableError('Karbon /v3/Notes/{id} did not match the expected shape');
    }
    return (parsed.data.Comments ?? [])
      .map((c) => ({
        author: c.AuthorEmailAddress ?? null,
        createdAt: c.CreatedDate ?? null,
        body: (c.CommentBody ?? '').trim(),
      }))
      .filter((c) => c.body.length > 0)
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  }

  /**
   * Each client's Ad Hoc work item (decision 5: one exists on every client),
   * found by title. Also the cheapest source of client names: one list call
   * covers every client.
   */
  async listAdHocWorkItems(title: string): Promise<AdHocWorkItem[]> {
    const filter = `contains(Title,${odataString(title)})`;
    const rows = await this.getAll(
      `/v3/WorkItems?$filter=${encodeURIComponent(filter)}`,
      rawWorkItem,
      100,
      '/v3/WorkItems',
    );
    const needle = title.trim().toLowerCase();
    const out: AdHocWorkItem[] = [];
    for (const w of rows) {
      if (!w.ClientKey) continue;
      if (!(w.Title ?? '').toLowerCase().includes(needle)) continue;
      out.push({
        workItemKey: w.WorkItemKey,
        clientKey: w.ClientKey,
        clientName: w.ClientName?.trim() || null,
      });
    }
    return out;
  }
}
