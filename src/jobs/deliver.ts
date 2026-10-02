/**
 * Delivery: the one step between a rendered email and a sent one. Applies the
 * mode (off / shadow / live), claims the send so a re-run never duplicates it,
 * and in a dry run writes previews to disk instead of sending anything.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Store } from '../db/store';
import { type EmailContent, wrapEmail } from '../email/layout';
import { EmailSendError, EmailSendUncertainError, type EmailTransport } from '../email/sendgrid';
import { logger } from '../logger';

export type EmailKind = 'csa_weekly' | 'partner_escalation' | 'manager_monthly' | 'admin_summary';
export type Mode = 'off' | 'shadow' | 'live';

export interface Delivery {
  kind: EmailKind;
  /** The week (YYYY-MM-DD Monday) or month (YYYY-MM) it covers. */
  period: string;
  /** Stable identity for dedup: "csa:CSA-1", "partners", "manager:dferris@…", "admin". */
  recipientKey: string;
  to: string[];
  content: EmailContent;
}

export type DeliveryOutcome =
  'sent' | 'already_sent' | 'previewed' | 'mode_off' | 'no_recipient' | 'failed' | 'in_doubt';

export interface DeliveryResult {
  kind: EmailKind;
  recipientKey: string;
  to: string[];
  deliveredTo: string[];
  subject: string;
  outcome: DeliveryOutcome;
  error?: string;
}

export interface DeliveryContext {
  mode: Mode;
  shadowTo: string | null;
  /** Null in a dry run. */
  store: Store | null;
  transport: EmailTransport | null;
  dryRun: boolean;
  /** Dry-run preview folder. */
  outDir: string | null;
}

export async function deliver(ctx: DeliveryContext, d: Delivery): Promise<DeliveryResult> {
  const base = { kind: d.kind, recipientKey: d.recipientKey, to: d.to, subject: d.content.subject };
  if (d.to.length === 0) return { ...base, deliveredTo: [], outcome: 'no_recipient' };

  if (ctx.dryRun) {
    if (ctx.outDir) await writePreview(ctx.outDir, d);
    return { ...base, deliveredTo: [], outcome: 'previewed' };
  }
  if (ctx.mode === 'off') {
    logger.info({ kind: d.kind, to: d.to, subject: d.content.subject }, 'mode off — not sending');
    return { ...base, deliveredTo: [], outcome: 'mode_off' };
  }
  if (!ctx.store || !ctx.transport) {
    return {
      ...base,
      deliveredTo: [],
      outcome: 'failed',
      error: 'email or database not configured',
    };
  }

  const shadow = ctx.mode === 'shadow';
  if (shadow && !ctx.shadowTo) {
    return { ...base, deliveredTo: [], outcome: 'failed', error: 'TG_SHADOW_TO is not set' };
  }
  const deliveredTo = shadow ? [ctx.shadowTo!] : d.to;
  const subject = shadow ? `[Shadow] ${d.content.subject}` : d.content.subject;
  const notice = shadow
    ? `Shadow mode — in live mode this email goes to: ${d.to.join(', ')}. Any Email buttons open drafts to the real people; nothing goes out unless you press Send.`
    : undefined;

  const claim = await ctx.store.claimSend({
    kind: d.kind,
    period: d.period,
    recipient: d.recipientKey,
    mode: shadow ? 'shadow' : 'live',
    deliveredTo: deliveredTo.join(', '),
    subject,
  });
  if (claim === null) return { ...base, deliveredTo, outcome: 'already_sent' };

  try {
    const text = notice ? `${notice}\n\n${d.content.text}` : d.content.text;
    const { messageId } = await ctx.transport({
      to: deliveredTo,
      subject,
      html: wrapEmail(d.content.bodyHtml, notice),
      text,
    });
    await ctx.store.markSent(claim, messageId);
    return { ...base, deliveredTo, outcome: 'sent' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof EmailSendUncertainError) {
      logger.error({ kind: d.kind, to: deliveredTo, err: message }, 'send outcome unknown');
      return { ...base, deliveredTo, outcome: 'in_doubt', error: message };
    }
    await ctx.store.releaseSend(claim);
    logger.error({ kind: d.kind, to: deliveredTo, err: message }, 'send failed');
    return {
      ...base,
      deliveredTo,
      outcome: 'failed',
      error: err instanceof EmailSendError ? message : `unexpected: ${message}`,
    };
  }
}

async function writePreview(outDir: string, d: Delivery): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const name = `${d.kind}--${d.recipientKey.replace(/[^a-z0-9.@-]+/gi, '_')}`;
  await writeFile(
    path.join(outDir, `${name}.html`),
    wrapEmail(d.content.bodyHtml, `Dry-run preview — would go to: ${d.to.join(', ')}`),
  );
  await writeFile(
    path.join(outDir, `${name}.txt`),
    `To: ${d.to.join(', ')}\nSubject: ${d.content.subject}\n\n${d.content.text}`,
  );
}

export function describeResults(results: DeliveryResult[]): string[] {
  return results.map((r) => {
    const who = r.deliveredTo.length > 0 ? r.deliveredTo.join(', ') : r.to.join(', ') || '(nobody)';
    return `${r.outcome.padEnd(12)} ${r.kind} → ${who}${r.error ? ` (${r.error})` : ''}`;
  });
}
