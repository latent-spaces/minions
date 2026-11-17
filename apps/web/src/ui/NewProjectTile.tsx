import { useState } from 'react';
import { Plus } from './icons';
import { NewProjectDialog } from './NewProjectDialog';
import './add-tile.css';

/** The new-project tile, first in the project grid: one card that opens the new-project popup (owner, 16 November 2026). */
export function NewProjectTile() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="k42-add-tile" onClick={() => setOpen(true)}>
      <span className="k42-add-tile-icon" aria-hidden="true"><Plus size={24} /></span>
      <span className="k42-add-tile-title">Build a new project</span>
      <span className="k42-add-tile-hint">Describe an idea and start your agents</span>
    </button>
    <NewProjectDialog open={open} onClose={() => setOpen(false)} />
  </>;
}
