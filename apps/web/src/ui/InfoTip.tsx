import { useEffect, useId, useRef, useState } from 'react';
import { CircleHelp } from 'lucide-react';
import './info-tip.css';

/** A ? button that explains a setting. Hover or focus shows the note; a click (or tap) keeps it open until the next
 *  click, Escape or a click elsewhere. The note is the button's description, so screen readers hear it too. */
export function InfoTip({ label, children }: { label: string; children: string }) {
  const id = useId(), [open, setOpen] = useState(false), anchor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => { if (event instanceof KeyboardEvent ? event.key === 'Escape' : !anchor.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', close);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  return <span ref={anchor} className={`k42-info-tip${open ? ' is-open' : ''}`}>
    <button type="button" className="k42-info-tip-button" aria-label={`About ${label}`} aria-describedby={id} aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <CircleHelp size={16} aria-hidden="true" />
    </button>
    <span id={id} role="tooltip" className="k42-info-tip-note">{children}</span>
  </span>;
}
