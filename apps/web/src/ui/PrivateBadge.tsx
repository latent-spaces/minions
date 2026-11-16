import { Lock } from './icons';
import './private-badge.css';

/** The words for a private project's lock: its tooltip, and the screen-reader text after the project's name. */
export const PRIVATE_NOTE = 'Private · not listed in Explore';

/**
 * The private mark, the monday way (shell polish 2026-10-18, section 12): a lock on the project's own stamp or
 * swatch means private, and no mark means public. A 14px white badge with a 2px white ring on the bottom-right
 * corner. It is decorative for screen readers, which get `PrivateNote` after the name instead.
 */
export function PrivateBadge() {
  return <span className="k42-private-badge" title={PRIVATE_NOTE} aria-hidden="true"><Lock size={8} strokeWidth={3} /></span>;
}

/** The same words as visually hidden text, placed right after the project's name. */
export function PrivateNote() {
  return <span className="visually-hidden">, {PRIVATE_NOTE}</span>;
}
