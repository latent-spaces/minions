// Observe contributor targets and the scheduled lifecycle start; native agents start separately.
export function recruitmentState(minimum: number | null | undefined, participants: number | null | undefined, deadline: string | null | undefined, now: number) {
  const target = deadline ? Date.parse(deadline) : NaN;
  const known = Number.isInteger(minimum) && minimum! > 0 && Number.isInteger(participants) && participants! >= 0;
  const remaining = known ? Math.max(0, minimum! - participants!) : null;
  const minutes = Number.isFinite(target) ? Math.max(0, Math.ceil((target - now) / 60000)) : null;
  return { remaining, minimumReached: remaining === 0, count: known ? participants! : null, minimum: known ? minimum! : null,
    progress: known ? Math.min(participants!, minimum!) : null,
    target: Number.isFinite(target) ? target : null, overdue: Number.isFinite(target) && target <= now,
    days: minutes === null ? null : Math.floor(minutes / 1440), hours: minutes === null ? null : Math.floor(minutes % 1440 / 60), minutes: minutes === null ? null : minutes % 60 };
}

/** The time to the target start, short enough for a small card: "11 days left", "1 day left" or "Starts today".
 *  Nothing once the date has passed or when there is no valid date. Days are calendar days in the viewer's time zone. */
export function startLabel(deadline: string | null | undefined, now: number): string | null {
  const target = deadline ? Date.parse(deadline) : NaN;
  if (!Number.isFinite(target) || target <= now) return null;
  const midnight = (time: number) => { const date = new Date(time); return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(); };
  const days = Math.round((midnight(target) - midnight(now)) / 86400000);
  return days <= 0 ? 'Starts today' : `${days} day${days === 1 ? '' : 's'} left`;
}
