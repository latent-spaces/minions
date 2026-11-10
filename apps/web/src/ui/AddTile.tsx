import type { LucideIcon } from 'lucide-react';
import './add-tile.css';

/**
 * A dashed tile with the footprint of a project card, for an action that would add to the grid it sits in:
 * "New project" first among Created by me, "Find your kind of trouble" where Joined is still empty.
 */
export function AddTile({ icon: Icon, title, text, onClick }: { icon: LucideIcon; title: string; text: string; onClick: () => void }) {
  return <button type="button" className="k42-add-tile" onClick={onClick}>
    <span className="k42-add-tile-icon" aria-hidden="true"><Icon size={22} strokeWidth={1.75} /></span>
    <span className="k42-add-tile-title">{title}</span>
    <span className="k42-add-tile-text">{text}</span>
  </button>;
}
