import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { FeedbackInput, FeedbackPage, FeedbackReport } from '@mlswarm/contracts';
import { FEEDBACK_KINDS } from '@mlswarm/contracts';
import type { FeedbackRequest } from '../feedback-api';
import { ApiError } from '../api';
import { hold, mayLeaveProject } from '../route';
import { Button } from './Button';
import { CloseButton } from './CloseButton';
import { Dialog } from './Dialog';
import './feedback.css';

export function FeedbackDialog({ request, profileId, accountId, page, onClose, moment, preferenceControl }: { request: FeedbackRequest; profileId: string; accountId: string; page: FeedbackPage; onClose: () => void; moment?: 'close' | 'pause'; preferenceControl?: ReactNode }) {
  const key = `mlswarm.feedback:${accountId}:${profileId}`;
  const [pending, setPending] = useState<FeedbackInput | null>(() => { try { return JSON.parse(sessionStorage.getItem(key) ?? 'null'); } catch { return null; } });
  // An earlier manual report may include explicit page/screenshot consent; recover it as manual feedback.
  const [lifecycle] = useState(() => moment && (!pending || pending.page === null && !pending.screenshot && /^After (closing|pausing) a project/.test(pending.body)) ? moment : undefined);
  const [reason, setReason] = useState('');
  const reasons = lifecycle === 'pause' ? ['Taking a break', 'Need to change direction', 'Something didn’t work', 'Other'] : ['Finished what I needed', 'Just testing', 'Something didn’t work', 'Other'];
  const [kind, setKind] = useState<FeedbackInput['kind']>(pending?.kind ?? 'bug'), [body, setBody] = useState(pending?.body ?? '');
  const [includePage, setIncludePage] = useState(pending?.page != null), [attachment, setAttachment] = useState<FeedbackInput['screenshot']>(pending?.screenshot ?? null);
  const [fileName, setFileName] = useState(pending?.screenshot ? 'Previously selected screenshot' : ''), [busy, setBusy] = useState(false), [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null), [sent, setSent] = useState<FeedbackReport | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null), locked = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; if (dialog.current && !dialog.current.open) dialog.current.showModal(); return () => { alive.current = false; }; }, []);
  const dirty = !!pending || !!body.trim() || !!attachment;
  useEffect(() => !sent && (dirty || busy || reading) ? hold() : undefined, [dirty, busy, reading, sent]);
  const close = () => { if (!busy && !reading && (sent || lifecycle || mayLeaveProject())) onClose(); };
  async function choose(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) { setError('Choose a PNG, JPEG or WebP screenshot up to 2 MiB.'); return; }
    setReading(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]!); reader.onerror = reject; reader.readAsDataURL(file); });
      if (alive.current) { setAttachment({ mime: file.type, base64 }); setFileName(file.name); }
    } catch { if (alive.current) setError('Could not read that screenshot. Choose it again.'); }
    finally { if (alive.current) setReading(false); }
  }
  async function send() {
    if (locked.current || reading) return;
    if (lifecycle && !pending && !reason && !body.trim()) { setError('Choose a reason or add a comment, or skip this feedback.'); return; }
    const input = pending ?? { client_request_id: crypto.randomUUID(), kind: lifecycle ? 'other' : kind, body: lifecycle ? `${lifecycle === 'close' ? 'After closing a project' : 'After pausing a project'}${reason ? `: ${reason}` : ''}${body.trim() ? `\n\n${body.trim()}` : ''}` : body.trim(), page: lifecycle ? null : includePage ? page : null, screenshot: lifecycle ? null : attachment };
    if (!input.body) { setError('Tell us what happened or what you would like to improve.'); return; }
    try { sessionStorage.setItem(key, JSON.stringify(input)); } catch { setError('Your browser could not keep a retry receipt. Allow session storage before sending.'); return; }
    locked.current = true; setPending(input); setBusy(true); setError(null);
    try {
      const result = await request<FeedbackReport>('/reports', input, profileId);
      if (!alive.current) return;
      sessionStorage.removeItem(key); setPending(null); setSent(result);
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof Error ? e.message : 'Could not confirm your feedback. Retry the same report.');
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && ![408, 429].includes(e.status)) {
        try { sessionStorage.removeItem(key); setPending(null); } catch { setError('The report was refused, but its retry receipt could not be cleared. Reload with session storage available.'); }
      }
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  return <Dialog ref={dialog} className={`feedback-dialog${lifecycle ? ' is-lifecycle' : ''}`} aria-labelledby="feedback-title" onCancel={e => { e.preventDefault(); close(); }} onClose={onClose}>
    <CloseButton label="Close feedback" onClick={close} disabled={busy || reading} />
    <h1 id="feedback-title">{sent ? 'Feedback sent' : lifecycle === 'close' ? 'How did this project go?' : lifecycle === 'pause' ? 'Why did you pause?' : 'Give us feedback'}</h1>
    {sent ? <><p role="status">Thank you. Your report is in the MyLittleSwarm team’s private inbox.</p><p className="muted">Reference: <code>{sent.id.slice(0, 12)}</code> · {sent.status === 'new' ? 'New' : sent.status === 'reviewing' ? 'Reviewing' : 'Resolved'}</p><Button className="primary" onClick={close}>Done</Button></> : <>
      <p className="muted">{lifecycle ? 'Optional feedback, private to the MyLittleSwarm team.' : 'Only you and MyLittleSwarm platform admins can read this.'}</p>
      <form onSubmit={e => { e.preventDefault(); void send(); }}>
        <fieldset disabled={busy || reading || !!pending}>
          <legend className="visually-hidden">Feedback details</legend>
          {lifecycle && !pending ? <fieldset className="feedback-reasons"><legend>What best describes it? <span className="muted">(optional)</span></legend>{reasons.map(value => <label key={value}><input type="radio" name="feedback-reason" value={value} checked={reason === value} onChange={() => setReason(value)} />{value}</label>)}</fieldset> : !lifecycle && <div className="feedback-kinds" role="group" aria-label="Feedback type">{FEEDBACK_KINDS.map(value => <Button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)}>{value === 'bug' ? 'Bug' : value === 'idea' ? 'Idea' : 'Other'}</Button>)}</div>}
          {lifecycle && pending ? <p className="feedback-body">{pending.body}</p> : <><label htmlFor="feedback-body">{lifecycle ? 'Add a comment (optional)' : 'What would you like us to know?'}</label>
          <textarea id="feedback-body" value={body} onChange={e => setBody(e.target.value)} required={!lifecycle} maxLength={lifecycle ? 3800 : 4000} rows={lifecycle ? 3 : 5} placeholder="What happened? What would make it better?" /></>}
          {!lifecycle && <><label htmlFor="feedback-screenshot">Attach screenshot <span className="muted">(optional)</span></label>
          <Button type="button" onClick={() => fileInput.current?.click()}>Choose screenshot</Button>
          <input ref={fileInput} hidden id="feedback-screenshot" type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { void choose(e.target.files?.[0]); e.target.value = ''; }} />
          {attachment && <p className="feedback-file">{fileName}<Button type="button" onClick={() => { setAttachment(null); setFileName(''); }}>Remove screenshot</Button></p>}
          <p className="muted">Up to 2 MiB. Check for private details before sending. Nothing is captured automatically.</p>
          <label className="feedback-context"><input type="checkbox" checked={includePage} onChange={e => setIncludePage(e.target.checked)} />Include current page: {pending?.page ?? page}</label>
          <p className="muted">Only this page label is included, never its URL, project data or conversations.</p></>}
          {lifecycle && <p className="muted">Only your reason and comment are sent. No project details are attached.</p>}
        </fieldset>
        {reading && <p role="status">Reading screenshot…</p>}{error && <p role="alert" className="error">{error}</p>}
        {preferenceControl}
        <div className="feedback-actions"><Button type="button" disabled={busy || reading} onClick={close}>{lifecycle ? 'Skip' : 'Cancel'}</Button><Button className="primary" aria-busy={busy || undefined} disabled={busy || reading} type="submit">{busy ? 'Sending…' : pending ? 'Retry same feedback' : 'Send feedback'}</Button></div>
      </form>
    </>}
  </Dialog>;
}
