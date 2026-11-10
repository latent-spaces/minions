import type { ModerationNotification } from '@mlswarm/contracts';

// The notifications bell: a Needs you tab (open human requests) and an Updates tab (unread moderation notices).
// Mentions and joins have no feed yet.

/** The badge: none at 0, the open count up to 9, then "9+"; "N+" when the inbox has another page after this one. */
export function bellBadge(count: number, more: boolean): string | null {
  if (count <= 0) return null;
  if (count > 9) return '9+';
  return more ? `${count}+` : String(count);
}

/** The bell's accessible name: "Notifications, N need you"; plain "Notifications" until the count is known. */
export function bellLabel(count: number | null, more: boolean): string {
  if (count === null) return 'Notifications';
  const badge = bellBadge(count, more);
  if (badge === null) return more ? 'Notifications, more updates available' : 'Notifications, nothing new';
  return `Notifications, ${badge} unread`;
}

/** Newest first. The service already orders them; this keeps the bell right whatever the page order. */
export const newestFirst = <T extends { createdAt: number }>(items: readonly T[]): T[] => [...items].sort((a, b) => b.createdAt - a.createdAt);

/** How long ago, in the row's compact corner: now, 5m, 3h, 2d, then the date; a clock running behind reads as "now". */
export function shortAge(createdAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  const days = Math.floor(seconds / 86_400);
  if (days < 7) return `${days}d`;
  return new Date(createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export type BellTab = 'needs-you' | 'updates';
/** The popover opens on Needs you while anything waits for an answer, otherwise on Updates. */
export const defaultBellTab = (needsYouCount: number): BellTab => needsYouCount > 0 ? 'needs-you' : 'updates';

/** The verb between the moderator and the agent in an Updates row. */
export const moderationAction = (notice: Pick<ModerationNotification, 'action'>) => notice.action === 'end_participation' ? 'ended participation for' : notice.action === 'pause' ? 'requested Pause for' : 'requested Stop for';
