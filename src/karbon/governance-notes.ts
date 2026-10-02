/**
 * Karbon governance notes: the Karbon-side history of what the emails say, on
 * each recipient's Hidden Governance client, so people who live in Karbon have
 * somewhere to go — and CSAs can record their follow-up as comments, which the
 * Friday escalation reads back.
 *
 * Two hard rules:
 *  - A note only ever goes to a client that is RestrictionLevel "Hidden" and of
 *    the governance client type. Checked on every run, not just at setup —
 *    otherwise someone loosening a client's visibility in Karbon would quietly
 *    put staff performance notes in front of the whole firm.
 *  - Karbon notes cannot be deleted through the API, so a post is claimed first
 *    and never blindly retried (see KarbonClient.postNote).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Store } from '../db/store';
import { escapeHtml } from '../format';
import { logger } from '../logger';
import {
  KarbonApiError,
  type KarbonClient,
  type KarbonClientRef,
  KarbonWriteUncertainError,
} from './client';

export type NotesMode = 'off' | 'shadow' | 'live';

export type NoteKind = 'employee_review' | 'partner_escalation' | 'manager_utilization';

export interface NotesContext {
  mode: NotesMode;
  /** Karbon user the notes are posted as. */
  author: string | null;
  /** Required client type; null = only the Hidden check. */
  requiredClientType: string | null;
  shadowClientId: string | null;
  shadowAssignee: string | null;
  dryRun: boolean;
  outDir: string | null;
}

export const NOTES_OFF: NotesContext = {
  mode: 'off',
  author: null,
  requiredClientType: null,
  shadowClientId: null,
  shadowAssignee: null,
  dryRun: false,
  outDir: null,
};

export interface NoteDelivery {
  kind: NoteKind;
  period: string;
  /** Employee email for per-person notes; recipient key for summaries. */
  subjectKey: string;
  /** The governance client's Karbon client ID; null = none configured. */
  clientId: string | null;
  assignee: string | null;
  dueDate: string | null;
  subject: string;
  bodyHtml: string;
}

export type NoteOutcome =
  | 'posted'
  | 'already_posted'
  | 'previewed'
  | 'mode_off'
  | 'no_client'
  | 'refused'
  | 'failed'
  | 'in_doubt';

export interface NoteResult {
  kind: NoteKind;
  subject: string;
  clientId: string | null;
  outcome: NoteOutcome;
  detail?: string;
}

type Resolved = { ok: true; target: KarbonClientRef } | { ok: false; reason: string };

/** Resolves governance client IDs once per run and applies the Hidden + type check. */
export class GovernanceClients {
  private readonly cache = new Map<string, Promise<Resolved>>();

  constructor(
    private readonly karbon: KarbonClient,
    private readonly requiredClientType: string | null,
  ) {}

  resolve(clientId: string): Promise<Resolved> {
    let hit = this.cache.get(clientId);
    if (!hit) {
      hit = this.lookup(clientId);
      this.cache.set(clientId, hit);
    }
    return hit;
  }

  private async lookup(clientId: string): Promise<Resolved> {
    const found = await this.karbon.findClientByUserDefinedId(clientId);
    if (!found) return { ok: false, reason: `no Karbon client has the ID ${clientId}` };
    if ((found.restrictionLevel ?? '').toLowerCase() !== 'hidden') {
      return {
        ok: false,
        reason: `client ${clientId} is ${found.restrictionLevel ?? 'not Hidden'}, not Hidden — notes refused`,
      };
    }
    const want = this.requiredClientType?.trim().toLowerCase();
    if (want && (found.clientType ?? '').trim().toLowerCase() !== want) {
      return {
        ok: false,
        reason: `client ${clientId} is type "${found.clientType ?? 'none'}", not "${this.requiredClientType}" — notes refused`,
      };
    }
    return { ok: true, target: found };
  }
}

export async function postGovernanceNote(
  ctx: NotesContext,
  deps: { karbon: KarbonClient; store: Store | null; clients: GovernanceClients | null },
  d: NoteDelivery,
): Promise<NoteResult> {
  const base = { kind: d.kind, subject: d.subject, clientId: d.clientId };
  if (ctx.mode === 'off') return { ...base, outcome: 'mode_off' };
  if (!d.clientId) return { ...base, outcome: 'no_client' };
  if (ctx.dryRun) {
    // Dry runs still check the governance client, so a misconfigured one shows
    // up at the first test — but nothing is claimed or posted.
    if (deps.clients) {
      const real = await deps.clients.resolve(d.clientId).catch((err: unknown) => ({
        ok: false as const,
        reason: err instanceof Error ? err.message : String(err),
      }));
      if (!real.ok) return { ...base, outcome: 'refused', detail: real.reason };
    }
    if (ctx.outDir) await writeNotePreview(ctx.outDir, d);
    return { ...base, outcome: 'previewed' };
  }
  if (!deps.store || !deps.clients || !ctx.author) {
    return { ...base, outcome: 'failed', detail: 'notes need a database and KARBON_NOTE_AUTHOR' };
  }

  const shadow = ctx.mode === 'shadow';
  if (shadow && !ctx.shadowClientId) {
    return { ...base, outcome: 'failed', detail: 'KARBON_NOTES_SHADOW_CLIENT_ID is not set' };
  }
  let resolved: Resolved;
  try {
    // The real client is checked even in shadow mode, so the trial surfaces a
    // misconfigured governance client before live mode would refuse it.
    const real = await deps.clients.resolve(d.clientId);
    if (!real.ok) return { ...base, outcome: 'refused', detail: real.reason };
    resolved = shadow ? await deps.clients.resolve(ctx.shadowClientId!) : real;
  } catch (err) {
    return { ...base, outcome: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
  if (!resolved.ok)
    return { ...base, outcome: 'refused', detail: `shadow client: ${resolved.reason}` };

  const subject = shadow ? `[Shadow] ${d.subject}` : d.subject;
  const bodyHtml = shadow
    ? `<p><em>Shadow mode — in live mode this note goes to governance client ${escapeHtml(d.clientId)}${d.assignee ? `, assigned to ${escapeHtml(d.assignee)}` : ''}.</em></p>${d.bodyHtml}`
    : d.bodyHtml;
  const claim = await deps.store.claimNote({
    kind: d.kind,
    period: d.period,
    subjectKey: d.subjectKey,
    mode: shadow ? 'shadow' : 'live',
    clientKey: resolved.target.clientKey,
    subject,
  });
  if (claim === null) return { ...base, outcome: 'already_posted' };

  try {
    const noteId = await deps.karbon.postNote({
      subject,
      bodyHtml,
      authorEmail: ctx.author,
      assigneeEmail: shadow ? ctx.shadowAssignee : d.assignee,
      dueDate: d.dueDate,
      timeline: { entityType: resolved.target.type, entityKey: resolved.target.clientKey },
    });
    await deps.store.markNotePosted(claim, noteId);
    return { ...base, outcome: 'posted' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof KarbonWriteUncertainError) {
      logger.error({ kind: d.kind, subject, err: message }, 'note post outcome unknown');
      return { ...base, outcome: 'in_doubt', detail: message };
    }
    await deps.store.releaseNote(claim);
    return {
      ...base,
      outcome: 'failed',
      detail:
        err instanceof KarbonApiError
          ? `${message} (does the API key allow creating notes?)`
          : message,
    };
  }
}

async function writeNotePreview(outDir: string, d: NoteDelivery): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const name = `note--${d.kind}--${d.subjectKey.replace(/[^a-z0-9.@-]+/gi, '_')}.html`;
  await writeFile(
    path.join(outDir, name),
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(d.subject)}</title>
<p style="font:12px Arial;color:#666">Dry-run preview of a Karbon note → governance client ${escapeHtml(d.clientId ?? '')}${d.assignee ? `, assigned to ${escapeHtml(d.assignee)}` : ''}${d.dueDate ? `, due ${d.dueDate}` : ''}</p>
<h3 style="font:bold 15px Arial">${escapeHtml(d.subject)}</h3>
<div style="font:13px Arial">${d.bodyHtml}</div>`,
  );
}

export function describeNoteResults(results: NoteResult[]): string[] {
  return results.map(
    (r) =>
      `${r.outcome.padEnd(14)} ${r.kind} → ${r.clientId ?? '(no governance client)'}: ${r.subject}${r.detail ? ` (${r.detail})` : ''}`,
  );
}

/** Plain-text email → simple note HTML (paragraphs; "- " lines become a list). */
export function textToNoteHtml(text: string): string {
  const body = text.split('\n--\n')[0] ?? text;
  return body
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n').filter((l) => l.trim() !== '');
      if (lines.length > 0 && lines.every((l) => l.startsWith('- ') || l.startsWith('    '))) {
        return `<ul>${lines
          .filter((l) => l.startsWith('- '))
          .map((l) => `<li>${escapeHtml(l.slice(2))}</li>`)
          .join('')}</ul>`;
      }
      return `<p>${lines.map(escapeHtml).join('<br>')}</p>`;
    })
    .join('');
}

/** A Karbon comment body (may carry HTML) → one short plain line. */
export function commentText(body: string, max = 300): string {
  const plain = body
    .replace(/<\/?(b|i|u|em|strong|span|a)(\s[^>]*)?>/gi, '') // inline formatting: no gap
    .replace(/<[^>]+>/g, ' ') // block tags and line breaks: a space
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}
