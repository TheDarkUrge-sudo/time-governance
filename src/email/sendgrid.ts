/**
 * SendGrid — the only way this app sends mail. Plain REST (POST /v3/mail/send),
 * no SDK. Open and click tracking are off: these are internal staff emails.
 */
import { env } from '../env';

export interface OutboundEmail {
  to: string[];
  subject: string;
  html: string;
  text: string;
}

export type EmailTransport = (msg: OutboundEmail) => Promise<{ messageId: string }>;

/** SendGrid said no (bad request, auth, 5xx). Nothing was sent; safe to retry. */
export class EmailSendError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'EmailSendError';
  }
}

/**
 * The request was in flight when it failed (timeout, reset), so "accepted but
 * the reply was lost" can't be told from "never arrived". The send stays
 * claimed and is NOT retried automatically — the admin summary reports it.
 */
export class EmailSendUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailSendUncertainError';
  }
}

export function emailConfigured(): boolean {
  return Boolean(env.SENDGRID_API_KEY && env.SENDGRID_FROM_EMAIL);
}

export function sendgridTransport(): EmailTransport {
  const apiKey = env.SENDGRID_API_KEY;
  const from = env.SENDGRID_FROM_EMAIL;
  if (!apiKey || !from) {
    throw new Error('Email is not configured: set SENDGRID_API_KEY and SENDGRID_FROM_EMAIL.');
  }
  return async (msg) => {
    let res: Response;
    try {
      res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: msg.to.map((email) => ({ email })) }],
          from: { email: from, name: env.SENDGRID_FROM_NAME },
          ...(env.TG_REPLY_TO ? { reply_to: { email: env.TG_REPLY_TO } } : {}),
          subject: msg.subject,
          content: [
            { type: 'text/plain', value: msg.text },
            { type: 'text/html', value: msg.html },
          ],
          tracking_settings: {
            click_tracking: { enable: false, enable_text: false },
            open_tracking: { enable: false },
          },
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new EmailSendUncertainError(
        `SendGrid request did not complete (${err instanceof Error ? err.name : 'network error'})`,
      );
    }
    // A 5xx (often a gateway) can follow an accepted send, so it is not proof
    // nothing went out — treat it as in doubt rather than safe to re-send.
    if (res.status >= 500) {
      throw new EmailSendUncertainError(`SendGrid responded HTTP ${res.status}`);
    }
    if (!res.ok)
      throw new EmailSendError(`SendGrid rejected the email (HTTP ${res.status})`, res.status);
    return { messageId: res.headers.get('x-message-id') ?? 'unknown' };
  };
}
