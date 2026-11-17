import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Dialog } from './Dialog';
import { CloseButton } from './CloseButton';
import { mayLeaveProject } from '../route';
import './participant-popup.css';

/** Native dialog keeps focus inside and restores the activating control on close. */
export function ParticipantPopup({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId();
  const returnFocus = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => {
    const trigger = returnFocus.current;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); requestAnimationFrame(() => { if (trigger?.isConnected && trigger.checkVisibility() && !document.querySelector('dialog[open]')) trigger.focus({ preventScroll: true }); }); };
  }, []);
  const close = () => { if (mayLeaveProject()) onClose(); };
  return <Dialog ref={dialog} className="k42-participant-popup" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }}>
    <CloseButton label="Close popup" onClick={close} />
    <h2 id={titleId}>{title}</h2>
    {children}
  </Dialog>;
}
