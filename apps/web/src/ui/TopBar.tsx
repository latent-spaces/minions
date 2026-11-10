import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { Button } from './Button';
import { CloseButton } from './CloseButton';
import { isSearchShortcut } from './shell-nav';
import './top-bar.css';

/** The row at the top of the content area, above the page title (shell polish 2026-10-18, section 12): the search on
 *  the left, the shortcuts on the right. On compact screens it is the page's top bar, with the menu button and logo
 *  (`leading`), and the search opens from an icon as a full-width field. */
export function TopBar({ search, onSearch, onSubmit, placeholder, actions, notifications, leading, compact = false }: {
  search: string; onSearch: (value: string) => void; onSubmit: () => void;
  /** Null where there is nothing to search (outside a project): the search is then not shown. */
  placeholder: string | null;
  /** The shortcuts after the bell: the account. */
  actions?: ReactNode;
  /** The notifications bell; it comes first among the shortcuts. The guest shell has none, having nothing to notify. */
  notifications?: ReactNode;
  leading?: ReactNode;
  compact?: boolean;
}) {
  const field = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const rowId = useId();
  useEffect(() => { if (!compact) setOpen(false); }, [compact]);
  useEffect(() => { if (compact && open) field.current?.focus(); }, [compact, open]);
  // Ctrl K (Cmd K on a Mac) focuses the search from anywhere, except under an open dialog.
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (placeholder === null || !isSearchShortcut(event) || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      if (compact) setOpen(true);
      field.current?.focus();
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, [compact, placeholder]);
  const close = () => { setOpen(false); opener.current?.focus(); };
  const form = placeholder !== null && <form role="search" aria-label="Site search" className="k42-top-search" onSubmit={event => { event.preventDefault(); onSubmit(); if (compact) close(); }}>
    <Search size={18} aria-hidden="true" />
    <input ref={field} value={search} maxLength={40} enterKeyHint="search" aria-label={placeholder} placeholder={placeholder} aria-keyshortcuts="Control+K Meta+K"
      onChange={event => onSearch(event.target.value)} onKeyDown={event => { if (compact && event.key === 'Escape') { event.preventDefault(); close(); } }} />
    {!compact && !search && <kbd className="k42-top-search-hint" aria-hidden="true">Ctrl K</kbd>}
  </form>;
  return <header className={`k42-top-bar${compact ? ' is-compact' : ''}`}>
    {compact && leading}
    {!compact && form}
    <div className="k42-top-shortcuts">
      {compact && form && <Button ref={opener} type="button" className="k42-top-icon" aria-label="Search" title="Search" aria-expanded={open} aria-controls={rowId} onClick={() => setOpen(value => !value)}><Search size={20} aria-hidden="true" /></Button>}
      {notifications}
      {actions}
    </div>
    {compact && open && form && <div id={rowId} className="k42-top-search-row">{form}<CloseButton label="Close search" onClick={close} /></div>}
  </header>;
}


