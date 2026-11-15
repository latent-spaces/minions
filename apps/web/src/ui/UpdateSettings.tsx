import { useEffect, useId, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { PROGRESS_LIMITS, UPDATE_EVERY_MINUTES, UPDATE_TOPICS, type ProjectUpdateSettings, type UpdateTopic } from '@minions/contracts';
import { isSettledRefusal } from '../task-model';
import { Button } from './Button';
import { SettingToggle } from './SettingToggle';

type Draft = Pick<ProjectUpdateSettings, 'everyMinutes' | 'topics' | 'slides' | 'additionalInstructions'>;
const TOPICS: Record<UpdateTopic, string> = { results: 'Results', blockers: 'Blockers', decisions: 'Decisions', summaries: 'Summaries' };
const pick = (value: ProjectUpdateSettings): Draft => ({ everyMinutes: value.everyMinutes, topics: value.topics, slides: value.slides, additionalInstructions: value.additionalInstructions });
const same = (a: Draft, b: Draft) => a.everyMinutes === b.everyMinutes && a.slides === b.slides && a.additionalInstructions === b.additionalInstructions && UPDATE_TOPICS.every(topic => a.topics.includes(topic) === b.topics.includes(topic));
const supported = (value: ProjectUpdateSettings) => value && UPDATE_EVERY_MINUTES.includes(value.everyMinutes)
  && Array.isArray(value.topics) && value.topics.length > 0 && value.topics.every(topic => UPDATE_TOPICS.includes(topic))
  && typeof value.slides === 'boolean' && typeof value.additionalInstructions === 'string' && Number.isInteger(value.revision);
const unsupported = 'The running engine returned an unsupported update-settings format. Update the engine, then try again.';

/** What the project's agents post to Updates: how often, about what, with slides or not, and the owner's own note
 *  (owner, 12 November 2026). Owner only; the service enforces it. */
export function UpdateSettings({ request, projectId, active }: { request: <T>(path: string, body?: object) => Promise<T>; projectId: string; active: boolean }) {
  const path = `/${encodeURIComponent(projectId)}/project-update-settings`;
  const [saved, setSaved] = useState<ProjectUpdateSettings | null>(null), [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [reload, setReload] = useState(0);
  // One request ID per draft: retrying an unconfirmed save sends the same request again.
  const requestId = useRef(crypto.randomUUID());
  const id = useId();
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    request<ProjectUpdateSettings>(path).then(value => { if (!cancelled) {
      if (!supported(value)) { setError(unsupported); return; }
      setSaved(value); setDraft(current => current ?? pick(value)); setError('');
    } },
      reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not read the update settings.'); });
    return () => { cancelled = true; };
  }, [active, path, request, reload]);
  if (!saved || !draft) return <div className="settings-section">{error ? <><p role="alert" className="error">{error}</p><Button type="button" onClick={() => setReload(value => value + 1)}>Try again</Button></> : <p className="muted" role="status">Loading update settings…</p>}</div>;
  const change = (next: Partial<Draft>) => { requestId.current = crypto.randomUUID(); setError(''); setDraft({ ...draft, ...next }); };
  const dirty = !same(draft, pick(saved)), left = PROGRESS_LIMITS.instructions - [...draft.additionalInstructions].length;
  const save = async () => {
    setBusy(true); setError('');
    try {
      const value = await request<ProjectUpdateSettings>(path, { expectedRevision: saved.revision, clientRequestId: requestId.current, ...draft });
      if (!supported(value)) { setError(unsupported); return; }
      setSaved(value); setDraft(pick(value));
    } catch (reason) {
      setError(isSettledRefusal(reason) ? (reason instanceof Error ? reason.message : 'Could not save the update settings.') : 'Save not confirmed. Save again to confirm it.');
    } finally { setBusy(false); }
  };
  return <form className="settings-section update-settings" onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="setting-toggle">
      <span className="setting-toggle-label" id={`${id}-every`}>How often</span>
      <div className="setting-toggle-options" role="group" aria-labelledby={`${id}-every`}>
        {UPDATE_EVERY_MINUTES.map(minutes => <Button key={minutes} type="button" aria-pressed={draft.everyMinutes === minutes} disabled={busy} onClick={() => change({ everyMinutes: minutes })}>{minutes} min</Button>)}
      </div>
    </div>
    <div className="setting-toggle">
      <span className="setting-toggle-label" id={`${id}-topics`}>What to post about</span>
      <div className="update-settings-topics" role="group" aria-labelledby={`${id}-topics`}>
        {UPDATE_TOPICS.map(topic => { const on = draft.topics.includes(topic); return <Button key={topic} type="button" aria-pressed={on} disabled={busy || (on && draft.topics.length === 1)}
          onClick={() => change({ topics: UPDATE_TOPICS.filter(other => other === topic ? !on : draft.topics.includes(other)) })}>{on && <Check size={16} aria-hidden="true" />}{TOPICS[topic]}</Button>; })}
      </div>
    </div>
    <SettingToggle label="Slides" info="On lets one update carry up to five images to swipe through. Off keeps one image per update." value={draft.slides} disabled={busy} onChange={slides => change({ slides })} />
    <div className="update-settings-note">
      <label htmlFor={`${id}-note`}>Extra instructions <span className="muted">(optional)</span></label>
      <textarea id={`${id}-note`} rows={2} value={draft.additionalInstructions} placeholder="For example: write for customers, not engineers." onChange={event => change({ additionalInstructions: event.target.value })} />
      {left < 100 && <p className={left < 0 ? 'error' : 'muted'}>{left < 0 ? `${-left} characters too long.` : `${left} characters left.`}</p>}
    </div>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="settings-save-row"><Button disabled={!dirty || busy || left < 0}>{busy ? 'Saving…' : 'Save update settings'}</Button>{dirty && !busy && <Button type="button" className="soft" onClick={() => { requestId.current = crypto.randomUUID(); setError(''); setDraft(pick(saved)); }}>Discard changes</Button>}</div>
  </form>;
}
