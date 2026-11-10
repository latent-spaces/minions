import type { PastelTone } from './avatar-tone';

// Status tags get a pastel by meaning (owner direction, 16 October 2026): open = mint, about to start = sky,
// waiting on a reviewer = lilac, still being prepared = butter, stopped or refused = blush. Finished, paused and
// unknown states stay neutral.
const EXACT: Record<string, PastelTone> = {
  'Open to new people': 'mint', 'Ready to start': 'sky', 'Waiting for the owner to start': 'sky', 'Waiting for review': 'lilac', 'Changes requested': 'lilac',
  Draft: 'butter', Rejected: 'blush', Withdrawn: 'blush', Revoked: 'blush',
};

/** The pastel for a status label as shown in the UI, or null when it stays neutral. */
export function statusTone(label: string): PastelTone | null {
  if (EXACT[label]) return EXACT[label];
  if (label.startsWith('Approved')) return 'butter';
  return null;
}

/** ` k42-tone-<tone>` for appending to a className, or nothing for a neutral tag. */
export function toneClass(tone: PastelTone | null): string {
  return tone ? ` k42-tone-${tone}` : '';
}
