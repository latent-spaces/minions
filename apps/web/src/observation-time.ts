// Pure presentation helpers; safe in the packaged local UI without web authentication or API imports.
export function ago(ms: number, now = Date.now()): string | null {
  const s = Math.round((now - ms) / 1000);
  if (s < 0) return null;
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86_400 ? `${Math.round(s / 3600)} h ago` : null;
}
export function time(ms: number, relative = true, now = Date.now()): string {
  const absolute = new Date(ms).toLocaleString();
  const since = relative ? ago(ms, now) : null;
  return since ? `${absolute} (${since})` : absolute;
}
export const timeLeft = (ms: number) => { const m = Math.ceil(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min left` : `${m} min left`; };
const units: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3600], ['minute', 60]];
/** "5 minutes ago", "yesterday", "3 weeks ago": the largest whole unit, in the reader's language. */
export function relativeTime(ms: number, now = Date.now()): string {
  const s = (ms - now) / 1000, format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of units) if (Math.abs(s) >= size) return format.format(Math.round(s / size), unit);
  return Math.abs(s) < 45 ? 'just now' : format.format(Math.round(s / 60), 'minute');
}
