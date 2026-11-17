import { Button } from './Button';
import { CloseButton } from './CloseButton';
import { Dialog } from './Dialog';
import { useEffect, useRef, useState } from 'react';
import './confirm.css';

type Request = { description: string, action: string, title?: string, resolve: (confirmed: boolean) => void };
let ask: ((request: Request) => void) | null = null;

// The one "Are you sure?" of the website: a short description of what the action does and a button naming it.
// It answers false when dismissed. ConfirmHost, mounted once beside the application, shows it.
// The close event arrives after the answer, when the next request may already be showing, so only a
// dismissal (a request still waiting behind a closed dialog) answers false.
export const confirmAction = (description: string, action: string, title?: string) => new Promise<boolean>(resolve => { if (ask) ask({ description, action, title, resolve }); else resolve(false); });

export function ConfirmHost() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [request, setRequest] = useState<Request | null>(null);
  useEffect(() => { ask = next => setRequest(previous => { previous?.resolve(false); return next; }); return () => { ask = null; }; }, []);
  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    // The shared native dialog must own focus above the map, including native fullscreen.
    const show = async () => {
      if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch { /* showModal remains the native top layer */ } }
      if (!cancelled) dialog.current?.showModal();
    };
    void show();
    return () => { cancelled = true; };
  }, [request]);
  const answer = (confirmed: boolean) => { request?.resolve(confirmed); setRequest(null); dialog.current?.close(); };
  return <Dialog ref={dialog} className="confirm-dialog" aria-labelledby="confirm-title" aria-describedby="confirm-description" onClose={() => { if (request && !dialog.current?.open) answer(false); }}>
    <h2 id="confirm-title">{request?.title ?? 'Are you sure?'}</h2>
    <p id="confirm-description">{request?.description}</p>
    <div className="actions"><Button type="button" onClick={() => answer(false)}>Cancel</Button><Button type="button" className="primary" onClick={() => answer(true)}>{request?.action}</Button></div>
    {/* Last in order, so opening still focuses Cancel; it shows in the top corner and answers false like Cancel. */}
    <CloseButton onClick={() => answer(false)} />
  </Dialog>;
}
