import { AgentAvatar } from './AgentAvatar';
import { useEffect, useId, useRef, useState } from 'react';
import type { SessionUser } from '../session-identity';
import type { AgentPersona as Persona } from '@mlswarm/contracts';
import { ApiError, session, projects } from '../api';
import { hold } from '../route';
import { Button } from './Button';
import { Check } from 'lucide-react';
import './agent-persona.css';
import { PERSONA_OPTIONS, personaChoice, type PersonaChoice } from '@mlswarm/contracts';

const PERSONA_CARDS = [
  { id: 'default', label: 'Clean default', description: 'No added instructions.' },
  { id: 'build', label: 'Build', description: 'Make progress and verify changes.' },
  { id: 'review', label: 'Review', description: 'Find bugs and test assumptions.' },
  { id: 'updates', label: 'Share progress', description: 'Share clear updates with evidence.' },
  { id: 'moderator', label: 'Community rules', description: 'Flag concerns for human review.' },
  { id: 'custom', label: 'Custom', description: 'Write your own perspective.' },
] as const;

type Read = { agentId: string; persona: Persona; canEditPersona: boolean };
type Edit = { text: string; expectedRevision: number };
export function AgentPersona({ user, projectId, agentId, active, tick, agentName = 'Agent', ownerId, provider, onSaved }: { user: SessionUser | null; projectId: string; agentId: string; active: boolean; tick: number; agentName?: string; ownerId?: string | null; provider?: string | null; onSaved?: (text: string) => void }) {
  const [saved, setSaved] = useState<Read | null>(null), [text, setText] = useState('');
  const [choice, setChoice] = useState<PersonaChoice>('default'), customDraft = useRef('');
  const [pending, setPending] = useState<Edit | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState('');
  const [denied, setDenied] = useState(false);
  const live = useRef(true), sending = useRef(false);
  const inputId = useId(), path = `/${projectId}/agents/${agentId}/persona`;
  const dirty = !!saved && text !== saved.persona.text;
  const draftState = useRef({ dirty, pending, busy });
  draftState.current = { dirty, pending, busy };
  const current = () => live.current && !!user && session.currentUid() === user.uid;
  const validate = (value: Read) => {
    if (!value || value.agentId !== agentId || typeof value.persona?.text !== 'string'
      || !Number.isSafeInteger(value.persona.revision) || typeof value.canEditPersona !== 'boolean')
      throw new Error('The persona response was incomplete. Retry the original save.');
    return value;
  };
  useEffect(() => {
    live.current = true;
    let cancelled = false;
    if (user && active) projects<Read>(user, path).then(value => {
      if (!cancelled && current()) {
        validate(value); setDenied(false);
        if (!draftState.current.pending && !draftState.current.busy) setError(null);
        if (!draftState.current.dirty && !draftState.current.pending && !draftState.current.busy) {
          setSaved(value); setText(value.persona.text);
          setChoice(previous => previous === 'custom' && !value.persona.text ? previous : personaChoice(value.persona.text));
          if (personaChoice(value.persona.text) === 'custom') customDraft.current = value.persona.text;
        } else setSaved(previous => previous ? { ...previous, canEditPersona: value.canEditPersona } : value);
      }
    }).catch(failure => {
      if (!cancelled && current()) {
        if (failure instanceof ApiError && [401,403,404].includes(failure.status)) {setDenied(true);setSaved(null);}
        else setError(failure.message);
      }
    });
    return () => { cancelled = true; live.current = false; };
  }, [user?.uid, path, active, tick]);
  useEffect(() => active && !denied && (dirty || pending || busy) ? hold() : undefined, [active, denied, dirty, pending, busy]);
  async function save(edit: Edit) {
    if (!user || sending.current || !current()) return;
    sending.current = true; setBusy(true); setPending(edit); setError(null); setNotice('');
    try {
      const result = validate(await projects<Read>(user, path, edit));
      if (!current()) return;
      setSaved(result); setText(result.persona.text); setPending(null);
      setChoice(personaChoice(result.persona.text));
      onSaved?.(result.persona.text);
      setNotice('Saved. Your agent picks it up at its next step.');
    } catch (failure) {
      if (current()) {
        if (failure instanceof ApiError && [401,403,404].includes(failure.status)) {setDenied(true);setSaved(null);}
        setError((failure as Error).message);
      }
    } finally { sending.current = false; if (current()) setBusy(false); }
  }
  async function reload() {
    if (!user || busy) return;
    setBusy(true);
    try {
      const result = validate(await projects<Read>(user, path));
      if (current()) { setSaved(result); setText(result.persona.text); setChoice(personaChoice(result.persona.text)); customDraft.current = personaChoice(result.persona.text) === 'custom' ? result.persona.text : ''; setPending(null); setError(null); setNotice(''); }
    } catch (failure) { if (current()) setError((failure as Error).message); }
    finally { if (current()) setBusy(false); }
  }
  if (!user || session.currentUid() !== user.uid || !active || denied || !saved && !error) return null;
  return <section className="agent-panel" aria-labelledby={inputId + '-title'}>
    <h3 id={inputId + '-title'}>Persona</h3>
    <p className="agent-help">Optional · visible to project members. Leaving it blank uses the clean default.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {saved?.canEditPersona ? <form className="settings-form card-form" onSubmit={event => { event.preventDefault(); void save(pending ?? {text,expectedRevision:saved.persona.revision}); }}>
      <fieldset className="persona-choices" disabled={busy || !!pending}>
        <legend>Perspective or focus (optional)</legend>
        <div className="persona-card-grid">
          {PERSONA_CARDS.map(({ id, label, description }) => <label className="persona-choice" key={id}>
            <input type="radio" name={inputId + '-choice'} value={id} checked={choice === id}
              aria-label={label} aria-describedby={inputId + '-' + id + '-description'} onChange={() => {
                setChoice(id); setText(id === 'custom' ? customDraft.current : PERSONA_OPTIONS.find(option => option.id === id)!.text); setNotice('');
              }} />
            <span className="persona-choice-content"><AgentAvatar provider={provider} name={agentName} id={agentId} ownerId={ownerId} persona={id} size={40} decorative />
              <strong>{label}</strong><span id={inputId + '-' + id + '-description'}>{description}</span></span>
          </label>)}
        </div>
      </fieldset>
      {choice === 'custom' ? <><label htmlFor={inputId + '-custom'}>Your perspective</label>
        <textarea id={inputId + '-custom'} rows={3} maxLength={4000} value={text} disabled={busy || !!pending}
          onChange={event => {setText(event.target.value);customDraft.current = event.target.value;setNotice('');}} /></>
        : text ? <details className="persona-instructions"><summary>View instructions</summary><p className="agent-help">{text}</p></details> : null}
      <div className="actions">
        <Button className="primary" disabled={busy || [...text.trim()].length > 2000 || !dirty && !pending}><Check size={18} aria-hidden="true" />{busy ? 'Saving…' : pending ? 'Retry original save' : 'Save'}</Button>
        <Button type="button" disabled={busy || !!pending || !saved.persona.text} onClick={() => void save({text:'',expectedRevision:saved.persona.revision})}>Reset to default</Button>
        {(pending || error) && <Button className="soft" type="button" disabled={busy} onClick={() => void reload()}>Discard edits and load saved persona</Button>}
      </div>
    </form> : saved ? <p>{saved.persona.text || 'Clean default — no custom perspective.'}</p> : null}
  </section>;
}
