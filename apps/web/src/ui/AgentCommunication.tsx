import { useEffect, useId, useRef, useState } from 'react';
import type { SessionUser } from '../session-identity';
import { COMMUNICATION_BOUNDS as B, type CommunicationSettings } from '@mlswarm/contracts';
import { ApiError, session, projects } from '../api';
import { hold } from '../route';
import { Button } from './Button';
import { communicationDraft, communicationEdit, validateCommunicationSettings, type CommunicationDraft, type CommunicationMode } from './communication-settings';
import './agent-communication.css';

export function AgentCommunication({ user, projectId, agentId = null, active, tick }: {
  user: SessionUser | null; projectId: string; agentId?: string | null; active: boolean; tick: number;
}) {
  const [saved, setSaved] = useState<CommunicationSettings | null>(null);
  const [mode, setMode] = useState<CommunicationMode | null>(null), [draft, setDraft] = useState<CommunicationDraft | null>(null);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [denied, setDenied] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const live = useRef(true), sending = useRef(false), reads = useRef(0), state = useRef({ mode, busy, uncertain });
  state.current = { mode, busy, uncertain };
  const id = useId(), path = agentId ? `/${projectId}/agents/${agentId}/communication` : `/${projectId}/communication`;
  const current = () => live.current && !!user && session.currentUid() === user.uid;
  const dirty = !!saved && !!mode && !!draft && JSON.stringify(draft) !== JSON.stringify(communicationDraft(saved, mode));
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => !denied && (dirty || busy || uncertain) ? hold() : undefined, [denied, dirty, busy, uncertain]);
  function validate(value: CommunicationSettings) {
    return validateCommunicationSettings(value, agentId);
  }
  function failure(reason: unknown) {
    if (!current()) return;
    if (reason instanceof ApiError && [401,403,404].includes(reason.status)) {
      setDenied(true); setSaved(null); setMode(null); setDraft(null);
    }
    setError((reason as Error).message);
  }
  useEffect(() => {
    if (!user || !active) return;
    const request = ++reads.current;
    let cancelled = false;
    projects<CommunicationSettings>(user, path).then(value => {
      if (cancelled || !current() || request !== reads.current) return;
      const next = validate(value); setDenied(false);
      if (state.current.mode && !(state.current.mode === 'agent' ? next.canEditAgent : next.canEditDefaults)) {
        setSaved(next); setMode(null); setDraft(null); setUncertain(false); setError('Editing access changed. Current limits are shown.'); return;
      }
      if (state.current.busy || state.current.uncertain) return;
      if (state.current.mode && (state.current.mode === 'agent' ? next.canEditAgent : next.canEditDefaults)) return;
      setSaved(next); setMode(null); setDraft(null); setError('');
    }).catch(reason => { if (!cancelled && request === reads.current) failure(reason); });
    return () => { cancelled = true; };
  }, [user?.uid, path, active, tick]);
  function edit(next: CommunicationMode) {
    if (!saved) return;
    setDraft(communicationDraft(saved, next)); setMode(next); setError(''); setNotice('');
  }
  async function reload() {
    if (!user || sending.current || !current()) return;
    sending.current = true; setBusy(true); ++reads.current;
    try {
      const next = validate(await projects<CommunicationSettings>(user, path));
      if (current()) { setSaved(next); setDraft(null); setMode(null); setUncertain(false); setError(''); setDenied(false); }
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
      const target = mode === 'agent' ? path : `/${projectId}/communication`;
      const result = await projects<{ revision: number }>(user, target, input);
      if (!Number.isSafeInteger(result?.revision) || result.revision !== input.expectedRevision + 1) throw new Error('Save was not confirmed. Load saved settings before editing again.');
      const next = validate(await projects<CommunicationSettings>(user, path));
      if (current()) {
        setSaved(next); setDraft(null); setMode(null); setUncertain(false);
        setNotice('Limits saved. Recent usage still counts.');
      }
    } catch (reason) { if (current()) { setUncertain(true); failure(reason); } }
    finally { sending.current = false; if (current()) setBusy(false); }
  }
  if (!user || session.currentUid() !== user.uid || !active || denied) return null;
  const effective = saved?.effective;
  const numberFields = [
    ['sendsPerHour', 'Messages per hour', 1, B.sendsPerHour],
    ['minimumGapSeconds', 'Minimum send gap (seconds)', B.minimumGapSeconds, B.maximumGapSeconds],
    ['broadcastsPerHour', 'Agent broadcasts per hour', 1, B.broadcastsPerHour],
  ] as const;
  return <section className="agent-panel" aria-labelledby={id + '-title'}>
    <h3 id={id + '-title'}>{agentId ? 'Communication limits' : 'Communication limits'}</h3>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!saved && !error && <p role="status" className="agent-help">Loading limits…</p>}
    {effective && <>
      <dl className="agent-details-list">
        <div><dt>Broadcasting</dt><dd>{effective.broadcastAllowed ? 'Allowed' : 'Disabled'}</dd></div>
        <div><dt>Messages</dt><dd>{effective.sendsPerHour} / hour</dd></div>
        <div><dt>Send gap</dt><dd>{effective.minimumGapSeconds} seconds</dd></div>
        <div><dt>Agent broadcasts</dt><dd>{effective.broadcastsPerHour} / hour</dd></div>
        <div><dt>Shared project broadcasts</dt><dd>{effective.sharedBroadcastsPerHour} / hour per agent in the team</dd></div>
      </dl>
      <details className="settings-disclosure"><summary>How limits work</summary><p className="agent-help">Broadcasts count as messages. The shared allowance grows with the team. These are limits, not remaining messages.</p></details>
      {!mode && <div className="actions">
        {saved.canEditAgent && <Button type="button" onClick={() => edit('agent')}>Edit agent limits</Button>}
        {saved.canEditDefaults && <Button type="button" onClick={() => edit('project')}>Edit limits</Button>}
      </div>}
    </>}
    {mode && draft && saved?.configuration && <form className="settings-form agent-communication-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy || uncertain}>
        <legend>{mode === 'agent' ? 'Agent overrides' : 'Project defaults'}</legend>
        <p className="agent-help">{mode === 'agent' ? 'Leave blank to use the project default.' : 'Defaults apply unless an agent has an override. The shared allowance applies to everyone.'}</p>
        <label htmlFor={id + '-broadcast'}>Broadcast permission</label>
        <select id={id + '-broadcast'} value={draft.broadcastAllowed} onChange={event => setDraft({ ...draft, broadcastAllowed: event.target.value as CommunicationDraft['broadcastAllowed'] })}>
          {mode === 'agent' && <option value="inherit">Project default ({saved.configuration.defaults.broadcastAllowed ? 'allowed' : 'disabled'})</option>}
          <option value="allow">Allowed</option><option value="deny">Disabled</option>
        </select>
        {numberFields.map(([key, label, min, max]) => <div key={key}>
          <label htmlFor={id + key}>{label}</label>
          <input id={id + key} type="number" min={min} max={max} step="1" required={mode === 'project'} value={draft[key]}
            placeholder={mode === 'agent' ? `Project default: ${saved.configuration!.defaults[key]}` : undefined}
            onChange={event => setDraft({ ...draft, [key]: event.target.value })} />
        </div>)}
        {mode === 'project' && <><label htmlFor={id + '-shared'}>Shared project broadcasts per hour, per agent in the team</label>
          <input id={id + '-shared'} type="number" min="1" max={B.broadcastsPerHour} step="1" required value={draft.sharedBroadcastsPerHour}
            onChange={event => setDraft({ ...draft, sharedBroadcastsPerHour: event.target.value })} /></>}
      </fieldset>
      <div className="actions">
        <Button disabled={busy || uncertain || !dirty}>{busy ? 'Saving…' : 'Save limits'}</Button>
        {mode === 'agent' && <Button type="button" disabled={busy || uncertain || !saved.overriddenFields.length} onClick={() => void save(true)}>Use project defaults</Button>}
        {!uncertain && <Button type="button" disabled={busy} onClick={() => { setDraft(null); setMode(null); setError(''); }}>Cancel</Button>}
      </div>
    </form>}
    {uncertain && <><p className="agent-help">Save not confirmed. Read the saved settings before editing again.</p>
      <Button type="button" disabled={busy} onClick={() => void reload()}>Discard draft and load saved settings</Button></>}
    {!saved && error && <Button type="button" disabled={busy} onClick={() => void reload()}>Try again</Button>}
  </section>;
}
