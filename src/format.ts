/** Minutes → "3.5" (one decimal, hours). */
export function hours(minutes: number): string {
  return (Math.round(minutes / 6) / 10).toFixed(1);
}

/** 0.7045 → "70%". */
export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
