import { X } from './icons';
import { Button } from './Button';
import './close-button.css';

// The one X of the website: every dialog, drawer and sheet shows it in its top corner, beside Escape.
// Menus and small popovers close on Escape and outside click instead. `disabled` keeps a dialog open
// while it is busy, as its other ways of closing do.
export function CloseButton({ onClick, label = 'Close', disabled }: { onClick: () => void; label?: string; disabled?: boolean }) {
  return <Button type="button" className="k42-close" aria-label={label} disabled={disabled} onClick={onClick}><X size={20} aria-hidden="true" /></Button>;
}
