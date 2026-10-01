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

/** "Riley Chen" → "R. Chen" (the samples' style; single names pass through). */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name.trim();
  return `${parts[0]!.charAt(0)}. ${parts.slice(1).join(' ')}`;
}
