/**
 * The branded email shell. Table-based, inline-styled (email clients ignore
 * <style>), 660 px max.
 *
 * Brand rules (Clarity ADR-0057 + the firm brand guide):
 *  - The firm's red is #BA2025. The samples' #8B1A1A is retired.
 *  - Brand red sits in the same hue range as warning reds, so they are kept
 *    apart by treatment: brand red appears ONLY in the top bar. Tables use a
 *    neutral charcoal header row, and status reds are tinted pills or text,
 *    never a solid saturated fill.
 */
import { escapeHtml } from '../format';

export const BRAND_RED = '#BA2025';
export const CHARCOAL = '#333333';
export const BORDER = '#E5E5E5';
export const MUTED = '#666666';
export const INK = '#1F1F1F';
export const FONT = 'font-family:Arial,Helvetica,sans-serif';

export interface EmailContent {
  subject: string;
  /** The body only — `wrapEmail` adds the shell at send time. */
  bodyHtml: string;
  text: string;
}

export type PillTone = 'red' | 'amber' | 'blue' | 'grey';

const PILL: Record<PillTone, [bg: string, fg: string]> = {
  red: ['#FFEBEE', '#B71C1C'],
  amber: ['#FFF3E0', '#A84300'],
  blue: ['#E3F2FD', '#1565C0'],
  grey: ['#F0F0F0', '#444444'],
};

export function pill(label: string, tone: PillTone): string {
  const [bg, fg] = PILL[tone];
  return `<span style="background-color:${bg};color:${fg};font-size:11px;padding:3px 9px;border-radius:10px;white-space:nowrap;">${escapeHtml(label)}</span>`;
}

export function heading(title: string, sub: string): string {
  return `<h1 style="${FONT};color:${INK};font-size:18px;font-weight:bold;margin:0 0 4px;">${escapeHtml(title)}</h1>
<p style="${FONT};color:${MUTED};font-size:12px;margin:0 0 20px;">${escapeHtml(sub)}</p>`;
}

export function paragraph(html: string, opts: { muted?: boolean } = {}): string {
  const color = opts.muted ? MUTED : '#333333';
  const size = opts.muted ? 12 : 13;
  return `<p style="${FONT};color:${color};font-size:${size}px;line-height:1.6;margin:16px 0 0;">${html}</p>`;
}

export function sectionLabel(text: string): string {
  return `<p style="${FONT};color:#333333;font-size:13px;font-weight:bold;margin:0 0 10px;">${escapeHtml(text)}</p>`;
}

export interface Column {
  label: string;
  align?: 'left' | 'right';
}

/** A data table with a neutral header row. Cells are pre-escaped HTML. */
export function table(columns: Column[], rows: string[][]): string {
  const th = columns
    .map(
      (c) =>
        `<td style="padding:9px 8px;color:#ffffff;font-weight:bold;text-align:${c.align ?? 'left'};">${escapeHtml(c.label)}</td>`,
    )
    .join('');
  const body = rows
    .map((cells, i) => {
      const bg = i % 2 === 0 ? '#ffffff' : '#F9F9F9';
      const tds = cells
        .map(
          (cell, j) =>
            `<td style="padding:9px 8px;color:#333333;vertical-align:top;text-align:${columns[j]?.align ?? 'left'};">${cell}</td>`,
        )
        .join('');
      return `<tr style="background-color:${bg};border-bottom:1px solid ${BORDER};">${tds}</tr>`;
    })
    .join('\n');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${FONT};font-size:12px;border-collapse:collapse;">
<tr style="background-color:${CHARCOAL};">${th}</tr>
${body}
</table>`;
}

/** The summary tiles across the top of the CSA review. */
export function tiles(items: { label: string; value: number; alert?: boolean }[]): string {
  const cells = items
    .map((t, i) => {
      const color = t.alert && t.value > 0 ? '#B71C1C' : INK;
      const gap = i > 0 ? '<td width="10"></td>' : '';
      return `${gap}<td width="${Math.floor(100 / items.length)}%" style="background-color:#F5F5F5;border:1px solid ${BORDER};border-radius:8px;padding:14px;text-align:center;">
<div style="${FONT};color:${MUTED};font-size:11px;text-transform:uppercase;letter-spacing:0.3px;margin-bottom:4px;">${escapeHtml(t.label)}</div>
<div style="${FONT};color:${color};font-size:24px;font-weight:bold;">${t.value}</div></td>`;
    })
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;"><tr>${cells}</tr></table>`;
}

/** The full HTML document. `notice` (shadow mode) renders as a band above the body. */
export function wrapEmail(bodyHtml: string, notice?: string): string {
  const band = notice
    ? `<tr><td style="background-color:#FFF8E1;border-bottom:1px solid #F0D58C;padding:10px 24px;${FONT};font-size:12px;color:#5D4300;">${escapeHtml(notice)}</td></tr>`
    : '';
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background-color:#F5F5F5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F5F5F5;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:660px;background-color:#ffffff;border:1px solid ${BORDER};border-radius:8px;overflow:hidden;">
<tr><td style="background-color:${BRAND_RED};padding:18px 24px;"><span style="${FONT};color:#ffffff;font-size:20px;font-weight:bold;letter-spacing:0.5px;">HFA</span></td></tr>
${band}
<tr><td style="padding:24px 24px 24px;background-color:#ffffff;">
${bodyHtml}
</td></tr>
<tr><td style="border-top:1px solid ${BORDER};padding:12px 24px;${FONT};color:${MUTED};font-size:11px;background-color:#ffffff;">HFA – Official Documentation &nbsp;|&nbsp; Confidential</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function textFooter(): string {
  return '\n--\nHFA – Official Documentation | Confidential\n';
}
