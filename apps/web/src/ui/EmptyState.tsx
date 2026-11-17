import type { ReactNode } from 'react';
import type { LucideIcon } from './icons';
import type { PastelTone } from './avatar-tone';
import { toneClass } from './tag-tone';
import './empty-state.css';

/**
 * The designed empty state for popups, drawers and menus (shell polish 2026-10-18): an icon in a pastel circle, a
 * short title (system notices pass tone={null} for a grey tile), one line of explanation and, when there is one, an action. It sits inside surfaces that are already
 * white, so it is not a card and has no border; on the grey canvas, wrap it in a card that uses --card-border.
 * The title is a paragraph, not a heading, so the heading order of the popup around it stays untouched.
 */
export function EmptyState({ icon: Icon, title, children, action, tone = 'lilac', size = 'regular' }: {
  icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode; tone?: PastelTone | null; size?: 'compact' | 'regular' | 'large';
}) {
  return <div className={`k42-empty${size === 'compact' ? ' k42-empty-compact' : size === 'large' ? ' k42-empty-large' : ''}`}>
    <span className={`k42-empty-icon${tone ? toneClass(tone) : ' is-neutral'}`} aria-hidden="true"><Icon size={size === 'compact' ? 16 : 20} /></span>
    <p className="k42-empty-title">{title}</p>
    {children !== null && children !== undefined && children !== false && <div className="k42-empty-text">{children}</div>}
    {action && <div className="k42-empty-action">{action}</div>}
  </div>;
}
