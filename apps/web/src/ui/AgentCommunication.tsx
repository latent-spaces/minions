import { useEffect, useId, useRef, useState } from 'react';
import type { SessionUser } from '../session-identity';
import { COMMUNICATION_BOUNDS as B, type CommunicationSettings } from '@mlswarm/contracts';
import { ApiError, session, projects } from '../api';
import { hold } from '../route';
import { Button } from './Button';
import { InfoTip } from './InfoTip';
import { communicationDraft, communicationEdit, validateCommunicationSettings, type CommunicationDraft, type CommunicationMode } from './communication-settings';
import './agent-communication.css';

/** Communication limits, edited in place: each value is its own field, and Save appears once one changes.
 *  On an agent page the fields are that agent's overrides (blank uses the project default); in Settings they are the
 *  project defaults. Whoever cannot edit sees the values read-only. */
export function AgentCommunication({ user, projectId, agentId = null, active, tick }: {
  user: SessionUser | null; projectId: string; agentId?: string | null; active: boolean; tick: number;
}) {
  const [saved, setSaved] = useState<CommunicationSettings | null>(null), [draft, setDraft] = useState<CommunicationDraft | null>(null);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [denied, setDenied] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const mode: CommunicationMode | null = !saved ? null : agentId ? saved.canEditAgent ? 'agent' : null : saved.canEditDefaults ? 'project' : null;
  const dirty = !!saved && !!mode && !!draft && JSON.stringify(draft) !== JSON.stringify(communicationDraft(saved, mode));
  const live = useRef(true), sending = useRef(false), reads = useRef(0), state = useRef({ dirty, busy, uncertain });
  state.current = { dirty, busy, uncertain };
  const id = useId(), path = agentId ? `/${projectId}/agents/${agentId}/communication` : `/${projectId}/communication`;
  const current = () => live.current && !!user && session.currentUid() === user.uid;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => !denied && (dirty || busy || uncertain) ? hold() : undefined, [denied, dirty, busy, uncertain]);
  const editable = (value: CommunicationSettings): CommunicationMode | null => agentId ? value.canEditAgent ? 'agent' : null : value.canEditDefaults ? 'project' : null;
  function show(next: CommunicationSettings) {
    const editing = editable(next);
    setSaved(next); setDraft(editing ? communicationDraft(next, editing) : null); setUncertain(false);
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
      const next = validateCommunicationSettings(value, agentId); setDenied(false);
      // A refresh never overwrites an unsaved or unconfirmed edit, unless editing access is gone.
      if ((state.current.dirty || state.current.busy || state.current.uncertain) && editable(next)) return;
      show(next); setError('');
    }).catch(reason => { if (!cancelled && request === reads.current) failure(reason); });
    return () => { cancelled = true; };
  }, [user?.uid, path, active, tick]);
  async function reload() {
    if (!user || sending.current || !current()) return;
    sending.current = true; setBusy(true); ++reads.current;
    try {
      const next = validateCommunicationSettings(await projects<CommunicationSettings>(user, path), agentId);
      if (current()) { show(next); setError(''); setDenied(false); }
    } catch (reason) { failure(reason); }
    finally { sending.current = false; if (current()) setBusy(false); }
  }
  async function save(reset = false) {
    if (!user || !saved || !mode || !draft || sending.current || !current() || uncertain) return;
    let input;
    try { input = reset ? { expectedRevision: saved.configuration!.overrideRevision, fields: {} } : communicationEdit(saved, mode, draft); }
    catch (reason) { failure(reason); return; }
    sending.current = true; setBusy(true); setError(''); setNotice(''); ++reads.current;
    try {
      const result = await projects<{ revision: number }>(user, path, input);
      if (!Number.isSafeInteger(result?.revision) || result.revision !== input.expectedRevision + 1) throw new Error('Save was not confirmed. Load saved settings before editing again.');
      const next = validateCommunicationSettings(await projects<CommunicationSettings>(user, path), agentId);
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
  const help = 'Broadcasts count as messages. The shared allowance grows with the team. These are limits, not remaining messages.'
    + (mode === 'agent' ? ' Leave a field blank to use the project default.' : '');
  return <section className="agent-panel" aria-labelledby={id + '-title'}>
    <h3 id={id + '-title'} className="agent-panel-title">Communication limits<InfoTip label="communication limits">{help}</InfoTip></h3>
    {error && <p className="error" role="alert">{error}</p>}
    {!saved && !error && <p role="status" className="agent-help">Loading limits…</p>}
    {effective && !mode && <dl className="agent-details-list">
      <div><dt>Broadcasting</dt><dd>{effective.broadcastAllowed ? 'Allowed' : 'Disabled'}</dd></div>
      <div><dt>Messages</dt><dd>{effective.sendsPerHour} / hour</dd></div>
      <div><dt>Send gap</dt><dd>{effective.minimumGapSeconds} seconds</dd></div>
      <div><dt>Agent broadcasts</dt><dd>{effective.broadcastsPerHour} / hour</dd></div>
      <div><dt>Shared project broadcasts</dt><dd>{effective.sharedBroadcastsPerHour} / hour per agent in the team</dd></div>
    </dl>}
    {mode && draft && defaults && <form className="agent-limits" onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy || uncertain}>
        <div className="agent-limits-row">
          <label htmlFor={id + '-broadcast'}>Broadcasting</label>
          <select id={id + '-broadcast'} value={draft.broadcastAllowed} onChange={event => set('broadcastAllowed', event.target.value)}>
            {mode === 'agent' && <option value="inherit">Project default ({defaults.broadcastAllowed ? 'allowed' : 'disabled'})</option>}
            <option value="allow">Allowed</option><option value="deny">Disabled</option>
          </select>
        </div>
        {numberFields.map(([key, label, min, max]) => <div key={key} className="agent-limits-row">
          <label htmlFor={id + key}>{label}</label>
          <input id={id + key} type="number" inputMode="numeric" min={min} max={max} step="1" required={mode === 'project'} value={draft[key]}
            placeholder={mode === 'agent' ? `Default ${defaults[key]}` : undefined} onChange={event => set(key, event.target.value)} />
        </div>)}
        {mode === 'project' && <div className="agent-limits-row">
          <label htmlFor={id + '-shared'}>Shared broadcasts per hour, per agent in the team</label>
          <input id={id + '-shared'} type="number" inputMode="numeric" min="1" max={B.broadcastsPerHour} step="1" required value={draft.sharedBroadcastsPerHour}
            onChange={event => set('sharedBroadcastsPerHour', event.target.value)} />
        </div>}
      </fieldset>
      {(dirty || mode === 'agent' && !!saved?.overriddenFields.length) && !uncertain && <div className="settings-save-row">
        {dirty && <Button disabled={busy}>{busy ? 'Saving…' : 'Save limits'}</Button>}
        {dirty && <Button type="button" className="soft" disabled={busy} onClick={() => { setDraft(communicationDraft(saved!, mode)); setError(''); }}>Discard changes</Button>}
        {!dirty && mode === 'agent' && <Button type="button" className="soft" disabled={busy} onClick={() => void save(true)}>Use project defaults</Button>}
      </div>}
    </form>}
    {notice && <p role="status" className="agent-help">{notice}</p>}
    {uncertain && <div className="settings-save-row"><p className="agent-help">Save not confirmed. Load the saved settings before editing again.</p>
      <Button type="button" disabled={busy} onClick={() => void reload()}>Load saved settings</Button></div>}
    {!saved && error && <Button type="button" disabled={busy} onClick={() => void reload()}>Try again</Button>}
  </section>;
}
