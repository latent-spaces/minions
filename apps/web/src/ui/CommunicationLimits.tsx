import { useEffect, useId, useRef, useState } from 'react';
import type { SessionUser } from '../session-identity';
import { COMMUNICATION_BOUNDS as B, type CommunicationSettings } from '@minions/contracts';
import { ApiError, session, projects } from '../api';
import { hold } from '../route';
import { Button } from './Button';
import { InfoTip } from './InfoTip';
import { communicationDraft, communicationEdit, validateCommunicationSettings, type CommunicationDraft } from './communication-settings';
import './communication-limits.css';

/** The project's communication limits, edited in place in Settings: each value is its own field, and Save appears once
 *  one changes. They apply to every agent; there are no per-agent limits (owner, 12 November 2026). */
export function CommunicationLimits({ user, projectId, active, tick }: {
  user: SessionUser | null; projectId: string; active: boolean; tick: number;
}) {
  const [saved, setSaved] = useState<CommunicationSettings | null>(null), [draft, setDraft] = useState<CommunicationDraft | null>(null);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [denied, setDenied] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const editing = !!saved?.canEditDefaults;
  const dirty = !!saved && editing && !!draft && JSON.stringify(draft) !== JSON.stringify(communicationDraft(saved));
  const live = useRef(true), sending = useRef(false), reads = useRef(0), state = useRef({ dirty, busy, uncertain });
  state.current = { dirty, busy, uncertain };
  const id = useId(), path = `/${projectId}/communication`;
  const current = () => live.current && !!user && session.currentUid() === user.uid;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => !denied && (dirty || busy || uncertain) ? hold() : undefined, [denied, dirty, busy, uncertain]);
  function show(next: CommunicationSettings) {
    setSaved(next); setDraft(next.canEditDefaults ? communicationDraft(next) : null); setUncertain(false);
  }
  function failure(reason: unknown) {
    if (!current()) return;
    if (reason instanceof ApiError && [401,403,404].includes(reason.status)) { setDenied(true); setSaved(null); setDraft(null); }
    setError((reason as Error).message);
  }
  useEffect(() => {
    if (!user || !active) return;
    const request = ++reads.current;
    let cancelled = false;
    projects<CommunicationSettings>(user, path).then(value => {
      if (cancelled || !current() || request !== reads.current) return;
      const next = validateCommunicationSettings(value); setDenied(false);
      // A refresh never overwrites an unsaved or unconfirmed edit, unless editing access is gone.
      if ((state.current.dirty || state.current.busy || state.current.uncertain) && next.canEditDefaults) return;
      show(next); setError('');
    }).catch(reason => { if (!cancelled && request === reads.current) failure(reason); });
    return () => { cancelled = true; };
  }, [user?.uid, path, active, tick]);
  async function reload() {
    if (!user || sending.current || !current()) return;
    sending.current = true; setBusy(true); ++reads.current;
    try {
      const next = validateCommunicationSettings(await projects<CommunicationSettings>(user, path));
      if (current()) { show(next); setError(''); setDenied(false); }
    } catch (reason) { failure(reason); }
    finally { sending.current = false; if (current()) setBusy(false); }
  }
  async function save() {
    if (!user || !saved || !editing || !draft || sending.current || !current() || uncertain) return;
    let input;
    try { input = communicationEdit(saved, draft); }
    catch (reason) { failure(reason); return; }
    sending.current = true; setBusy(true); setError(''); setNotice(''); ++reads.current;
    try {
      const result = await projects<{ revision: number }>(user, path, input);
      if (!Number.isSafeInteger(result?.revision) || result.revision !== input.expectedRevision + 1) throw new Error('Save was not confirmed. Load saved settings before editing again.');
      const next = validateCommunicationSettings(await projects<CommunicationSettings>(user, path));
      if (current()) { show(next); setNotice('Limits saved. Recent usage still counts.'); }
    } catch (reason) { if (current()) { setUncertain(true); failure(reason); } }
    finally { sending.current = false; if (current()) setBusy(false); }
  }
  if (!user || session.currentUid() !== user.uid || !active || denied) return null;
  const effective = saved?.effective, defaults = saved?.configuration?.defaults;
  const set = (key: keyof CommunicationDraft, value: string) => { if (draft) { setDraft({ ...draft, [key]: value }); setNotice(''); } };
  const numberFields = [
    ['sendsPerHour', 'Messages per hour', 1, B.sendsPerHour],
    ['minimumGapSeconds', 'Minimum send gap (seconds)', B.minimumGapSeconds, B.maximumGapSeconds],
    ['broadcastsPerHour', 'Agent broadcasts per hour', 1, B.broadcastsPerHour],
  ] as const;
  const help = 'Broadcasts count as messages. The shared allowance grows with the team. These are limits, not remaining messages.';
  return <section className="agent-panel" aria-labelledby={id + '-title'}>
    <h3 id={id + '-title'} className="agent-panel-title">Communication limits<InfoTip label="communication limits">{help}</InfoTip></h3>
    {error && <p className="error" role="alert">{error}</p>}
    {!saved && !error && <p role="status" className="agent-help">Loading limits…</p>}
    {effective && !editing && <dl className="agent-details-list">
      <div><dt>Broadcasting</dt><dd>{effective.broadcastAllowed ? 'Allowed' : 'Disabled'}</dd></div>
      <div><dt>Messages</dt><dd>{effective.sendsPerHour} / hour</dd></div>
      <div><dt>Send gap</dt><dd>{effective.minimumGapSeconds} seconds</dd></div>
      <div><dt>Agent broadcasts</dt><dd>{effective.broadcastsPerHour} / hour</dd></div>
      <div><dt>Shared project broadcasts</dt><dd>{effective.sharedBroadcastsPerHour} / hour per agent in the team</dd></div>
    </dl>}
    {editing && draft && defaults && <form className="agent-limits" onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy || uncertain}>
        <div className="agent-limits-row">
          <label htmlFor={id + '-broadcast'}>Broadcasting</label>
          <select id={id + '-broadcast'} value={draft.broadcastAllowed} onChange={event => set('broadcastAllowed', event.target.value)}>
            <option value="allow">Allowed</option><option value="deny">Disabled</option>
          </select>
        </div>
        {numberFields.map(([key, label, min, max]) => <div key={key} className="agent-limits-row">
          <label htmlFor={id + key}>{label}</label>
          <input id={id + key} type="number" inputMode="numeric" min={min} max={max} step="1" required value={draft[key]} onChange={event => set(key, event.target.value)} />
        </div>)}
        <div className="agent-limits-row">
          <label htmlFor={id + '-shared'}>Shared broadcasts per hour, per agent in the team</label>
          <input id={id + '-shared'} type="number" inputMode="numeric" min="1" max={B.broadcastsPerHour} step="1" required value={draft.sharedBroadcastsPerHour}
            onChange={event => set('sharedBroadcastsPerHour', event.target.value)} />
        </div>
      </fieldset>
      {dirty && !uncertain && <div className="settings-save-row">
        <Button disabled={busy}>{busy ? 'Saving…' : 'Save limits'}</Button>
        <Button type="button" className="soft" disabled={busy} onClick={() => { setDraft(communicationDraft(saved!)); setError(''); }}>Discard changes</Button>
      </div>}
    </form>}
    {notice && <p role="status" className="agent-help">{notice}</p>}
    {uncertain && <div className="settings-save-row"><p className="agent-help">Save not confirmed. Load the saved settings before editing again.</p>
      <Button type="button" disabled={busy} onClick={() => void reload()}>Load saved settings</Button></div>}
    {!saved && error && <Button type="button" disabled={busy} onClick={() => void reload()}>Try again</Button>}
  </section>;
}
