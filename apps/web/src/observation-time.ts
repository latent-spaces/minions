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
