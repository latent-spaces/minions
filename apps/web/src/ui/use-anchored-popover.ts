import { useCallback, useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type ToggleEvent } from 'react';
import { nextItem } from './popover-keys';
import './popover.css';

const ITEMS = 'a[href], button:not(:disabled)';

/**
 * A small popover anchored under its trigger (shell polish 2026-10-18, section 12): the Create menu and the
 * notifications bell. The browser's popover="auto" puts it in the top layer, so the menu column's scrolling does not
 * clip it, and closes it on Escape and outside click; it has no X (Task 9 ruling). Opening focuses its first item,
 * the arrow keys move between its items, Tab out closes it, and closing returns focus to the trigger.
 */
export function useAnchoredPopover<P extends HTMLElement>({ align, onOpen }: { align: 'start' | 'end'; onOpen?: () => void }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<P>(null);
  const [open, setOpen] = useState(false);
  const opened = useRef(onOpen);
  opened.current = onOpen;
  const items = () => [...(panel.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
  /** Closes the popover; focus returns to the trigger unless `refocus` is false. */
  const close = useCallback((refocus = true) => {
    if (panel.current?.matches(':popover-open')) panel.current.hidePopover();
    if (refocus) trigger.current?.focus();
  }, []);
  // The anchor moves when the window gets wider or narrower, so the popover closes instead of floating away from it.
  // Height changes (a phone's address bar or keyboard) leave it open.
  useEffect(() => {
    if (!open) return;
    const width = window.innerWidth;
    const hide = () => { if (window.innerWidth !== width) close(false); };
    // A scrolling ancestor (the menu column, the page) moves the anchor too; scrolls inside the popover do not count.
    const scrolled = (event: Event) => { if (event.target instanceof Node && !panel.current?.contains(event.target) && event.target.contains(trigger.current)) close(false); };
    window.addEventListener('resize', hide);
    document.addEventListener('scroll', scrolled, true);
    return () => { window.removeEventListener('resize', hide); document.removeEventListener('scroll', scrolled, true); };
  }, [open, close]);
  const triggerProps = { ref: trigger, popoverTarget: id, 'aria-expanded': open, 'aria-controls': id };
  const panelProps = {
    ref: panel, id, popover: 'auto' as const, className: `k42-popover is-${align}`,
    // Placed before it shows, from the trigger's box; popover.css keeps it inside 16px gutters.
    onBeforeToggle: (event: ToggleEvent<P>) => {
      if (event.newState !== 'open' || !trigger.current) return;
      const box = trigger.current.getBoundingClientRect(), style = event.currentTarget.style;
      style.setProperty('--anchor-top', `${Math.round(box.bottom + 8)}px`);
      style.setProperty('--anchor-left', `${Math.round(box.left)}px`);
      style.setProperty('--anchor-right', `${Math.round(box.right)}px`);
    },
    onToggle: (event: ToggleEvent<P>) => {
      const opening = event.newState === 'open';
      setOpen(opening);
      if (opening) { items()[0]?.focus(); opened.current?.(); return; }
      // Escape, or a click on nothing focusable: focus comes back to the trigger. A click on another control keeps it there.
      const active = document.activeElement;
      if (!active || active === document.body || event.currentTarget.contains(active)) trigger.current?.focus();
    },
    onKeyDown: (event: KeyboardEvent<P>) => {
      const list = items();
      const next = nextItem(event.key, list.indexOf(document.activeElement as HTMLElement), list.length);
      if (next === null) return;
      event.preventDefault();
      list[next].focus();
    },
    onBlur: (event: FocusEvent<P>) => {
      const to = event.relatedTarget;
      if (to instanceof Node && !event.currentTarget.contains(to) && to !== trigger.current) close(false);
    },
  };
  return { open, close, triggerProps, panelProps };
}
