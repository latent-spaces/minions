import { useEffect, useState, type CSSProperties } from 'react';
import './toast.css';

type Toast = { id: number, message: string, kind: 'success' | 'error' | 'info' };
let show: ((toast: Toast) => void) | null = null;
let next = 0;
const PARTY = ['🎉', '✨', '🥳', '🎊', '⭐', '💛'];
// Where each confetti piece falls from and how late, fixed per piece so a redraw does not reshuffle it.
const PIECES = Array.from({ length: 18 }, (_, index) => ({ glyph: PARTY[index % PARTY.length], left: (index * 37) % 100, delay: (index % 6) * 0.08, turn: index % 2 ? 1 : -1 }));

// Placeholder confirmation that something worked (or a failure with no place of its own): a loud, silly line in
// the middle of the page that leaves by itself. ToastHost, mounted once beside the application, shows it.
export const notify = (message: string, kind: Toast['kind'] = 'success') => show?.({ id: ++next, message, kind });

export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    show = toast => {
      // The same line is not stacked twice.
      setToasts(current => current.some(item => item.message === toast.message) ? current : [...current, toast]);
      window.setTimeout(() => setToasts(current => current.filter(item => item.id !== toast.id)), toast.kind === 'error' ? 8000 : 4500);
    };
    return () => { show = null; };
  }, []);
  return <div className="toasts">
    {toasts.some(toast => toast.kind === 'success') && <div className="toast-confetti" aria-hidden="true">{PIECES.map((piece, index) =>
      <span key={index} style={{ left: `${piece.left}%`, animationDelay: `${piece.delay}s`, '--turn': piece.turn } as CSSProperties}>{piece.glyph}</span>)}</div>}
    {toasts.map(toast => <p key={toast.id} className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
      <span className="toast-glyph" aria-hidden="true">{toast.kind === 'error' ? '🙈' : toast.kind === 'info' ? '📦' : '🎉'}</span>{toast.message}</p>)}
  </div>;
}
