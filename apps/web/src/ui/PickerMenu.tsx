import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check } from './icons';
import { nextItem } from './popover-keys';
import './picker-menu.css';

export type PickerItem = { key: string; label: ReactNode; checked?: boolean; disabled?: boolean; title?: string; onSelect: () => void; aside?: ReactNode };
/** The summary (a chip, a face or an icon) is the control: it opens a small menu, like the selected simple-tasks design. */
export function PickerMenu({ label, summary, items, disabled, align = 'start', triggerLabel }: { label: string; summary: ReactNode; items: PickerItem[]; disabled?: boolean; align?: 'start' | 'end'; triggerLabel?: string }) {
  const [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), menuId = useId();
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('pointerdown', outside); };
  }, [open]);
  return <div className="k42-task-picker" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} type="button" className="k42-task-picker-trigger" aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} aria-label={triggerLabel ?? `${label}: change`} disabled={disabled} onClick={() => setOpen(v => !v)}>{summary}</button>
    {open && <div ref={menu} id={menuId} role="menu" aria-label={label} className={`k42-task-picker-menu${align === 'end' ? ' is-end' : ''}`}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); return; }
        // Disabled choices cannot take focus. Keep navigation inside this menu so another field's keys stay its own.
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const next = nextItem(event.key, buttons.indexOf(document.activeElement as HTMLButtonElement), buttons.length);
        if (next !== null) { event.preventDefault(); event.stopPropagation(); buttons[next].focus(); }
      }}>
      {items.map(item => { const choose = <button key={item.key} type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={item.checked}
        className="k42-task-picker-item" disabled={item.disabled} title={item.title} onClick={() => { item.onSelect(); setOpen(false); trigger.current?.focus(); }}>
        {item.label}{item.checked && <Check size={16} aria-hidden="true" />}</button>;
        // An aside (a help button) sits beside the item, never inside it.
        return item.aside ? <div key={item.key} role="none" className="k42-task-picker-row">{choose}{item.aside}</div> : choose; })}
    </div>}
  </div>;
}
