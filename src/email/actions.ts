/**
 * "Email Jordan" buttons: mailto links that open a prefilled draft in the
 * reader's own mail client. Nothing is sent from here — the reader edits the
 * draft and presses Send, so the follow-up comes from them, not from a robot.
 *
 * Kept to plain mailto (no tracking, no app links): it works in Outlook,
 * Gmail and phones, and needs no new service. HTML only — the plain-text part
 * (and the Karbon notes built from it) carries no links.
 */
import { escapeHtml } from '../format';
import { CHARCOAL, FONT } from './layout';

export interface Draft {
  to: string[];
  cc?: string[];
  subject: string;
  /** Greeting and ask, plain text. Newlines become CRLF in the link (RFC 6068). */
  opening: string;
  /** One line each (the entries to fix); dropped from the end if the link gets too long. */
  details?: string[];
  /** The sign-off and anything after the details. */
  closing: string;
}

/**
 * Some desktop clients (classic Outlook) truncate or refuse mailto links much
 * past 2,000 characters, so the details are shortened to fit.
 */
export const MAX_MAILTO_LENGTH = 1800;

function encodeAddresses(list: string[]): string {
  // Addresses are validated on roster import; '@' is left readable.
  return list.map((a) => strict(a).replace(/%40/g, '@')).join(',');
}

/** encodeURIComponent leaves ' ! ( ) * alone; encode them too, so nothing in the link depends on HTML entity decoding. */
const strict = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const encode = (s: string) => strict(s.replace(/\r?\n/g, '\r\n'));

export function draftBody(d: Draft, details = d.details ?? []): string {
  return [d.opening, ...(details.length > 0 ? [details.join('\n')] : []), d.closing].join('\n\n');
}

export function mailtoHref(d: Draft): string {
  const build = (body: string) => {
    const params = [];
    if (d.cc && d.cc.length > 0) params.push(`cc=${encodeAddresses(d.cc)}`);
    params.push(`subject=${encode(d.subject)}`);
    params.push(`body=${encode(body)}`);
    return `mailto:${encodeAddresses(d.to)}?${params.join('&')}`;
  };
  const all = d.details ?? [];
  // Entry lines start "- "; headings and blank lines only frame them, so they
  // aren't counted in "+N more" (when there are no "- " lines, every line counts).
  const isItem = all.some((l) => l.startsWith('- '))
    ? (l: string) => l.startsWith('- ')
    : (l: string) => l.trim() !== '';
  let href = build(draftBody(d));
  for (let keep = all.length - 1; href.length > MAX_MAILTO_LENGTH && keep >= 0; keep--) {
    const kept = all.slice(0, keep);
    // Never end on a heading or blank line left with none of its entries.
    while (kept.length > 0 && !isItem(kept[kept.length - 1]!)) kept.pop();
    const more = all.slice(kept.length).filter(isItem).length;
    href = build(draftBody(d, [...kept, `(+${more} more — see Karbon)`]));
  }
  return href;
}

/** A small outlined button — neutral, so it never competes with the brand bar or a status pill. */
export function actionButton(label: string, draft: Draft): string {
  return linkButton(label, mailtoHref(draft));
}

/** The same button for any link (e.g. "Open timesheet" into Karbon). */
export function linkButton(label: string, href: string): string {
  return `<a href="${escapeHtml(href)}" style="${FONT};display:inline-block;margin:6px 6px 0 0;padding:4px 10px;border:1px solid ${CHARCOAL};border-radius:4px;color:${CHARCOAL};font-size:11px;font-weight:bold;text-decoration:none;white-space:nowrap;">${escapeHtml(label)}</a>`;
}

/** "Jordan" from "Jordan Lee" or "Lee, Jordan". */
export function firstName(name: string | null | undefined): string | null {
  const n = (name ?? '').trim();
  if (!n) return null;
  if (n.includes(',')) return n.split(',')[1]?.trim().split(/\s+/)[0] || null;
  return n.split(/\s+/)[0] ?? null;
}

/** "Hi Jordan," — or "Hi," when there is no usable name. */
export const greeting = (name: string | null | undefined) => {
  const f = firstName(name);
  return f ? `Hi ${f},` : 'Hi,';
};

/** "Thanks,\nTaylor" — or just "Thanks," for a shared mailbox (the Partners). */
export const signOff = (name: string | null | undefined) => {
  const f = firstName(name);
  return f ? `Thanks,\n${f}` : 'Thanks,';
};
