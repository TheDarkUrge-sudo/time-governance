/**
 * Links into Karbon's web app. The API does not document these addresses, so
 * the pattern is a setting (KARBON_TIMESHEET_URL), copied from the address bar:
 *
 *   https://app2.karbonhq.com/<tenant key>/timesheet/{key}
 *
 * Unset = no links. If Karbon ever moves the route, the setting changes, not
 * the code. Only https karbonhq.com addresses are accepted, and only a plain
 * Karbon key is ever substituted in.
 */

/** Karbon keys are short alphanumeric strings (e.g. "4bLnlnsHm4pM"). */
const KEY = /^[A-Za-z0-9_-]{4,64}$/;

/** Why a URL pattern is unusable, or null when it is fine. */
export function timesheetUrlProblem(template: string): string | null {
  if (!template.includes('{key}')) return 'must contain {key} where the timesheet key goes';
  let url: URL;
  try {
    url = new URL(template.replace('{key}', 'KEY'));
  } catch {
    return 'is not a valid URL';
  }
  if (url.protocol !== 'https:') return 'must start with https://';
  const host = url.hostname.toLowerCase();
  if (host !== 'karbonhq.com' && !host.endsWith('.karbonhq.com')) {
    return 'must be a karbonhq.com address';
  }
  return null;
}

/** The web address of a timesheet, or null without a pattern or a usable key. */
export function timesheetUrl(template: string | null, key: string | null): string | null {
  if (!template || !key || !KEY.test(key)) return null;
  return template.replace('{key}', encodeURIComponent(key));
}
