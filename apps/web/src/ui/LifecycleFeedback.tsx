import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { FeedbackPreferences, SaveFeedbackPreferences } from '@mlswarm/contracts';
import type { FeedbackRequest } from '../feedback-api';
import { ApiError } from '../api';
import { FeedbackDialog } from './FeedbackDialog';
import { Button } from './Button';
import './feedback.css';

export type FeedbackMoment = 'close' | 'pause';
type Preferences = { value: FeedbackPreferences | null; busy: boolean; error: string; reload: () => void; save: (enabled: boolean) => Promise<boolean> };
const LifecycleFeedbackContext = createContext<(action: FeedbackMoment) => void>(() => {});
const PreferencesContext = createContext<Preferences | null>(null);
export const useLifecycleFeedback = () => useContext(LifecycleFeedbackContext);

/** Shell-owned so closing can navigate to My projects without losing the invitation or draft. */
export function LifecycleFeedbackProvider({ request, profileId, accountId, children }: { request: FeedbackRequest; profileId: string; accountId: string; children: ReactNode }) {
  const [value, setValue] = useState<FeedbackPreferences | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [moment, setMoment] = useState<FeedbackMoment | null>(null), [open, setOpen] = useState(false);
  const alive = useRef(false), locked = useRef(false), pending = useRef<SaveFeedbackPreferences | null>(null);
  const invitation = useRef(0), returnFocus = useRef<HTMLElement | null>(null);
  async function load() {
    try { const saved = await request<FeedbackPreferences>('/preferences'); if (alive.current) { setValue(current => current && current.revision > saved.revision ? current : saved); setError(''); } return saved; }
    catch { if (alive.current) { setValue(null); setError('Could not load feedback preferences. Try again.'); } return null; }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [request]);
  async function save(promptsEnabled: boolean) {
    if (locked.current || !value) return false;
    locked.current = true; setBusy(true); setError('');
    const input = pending.current ?? { promptsEnabled, expected_revision: value.revision, client_request_id: crypto.randomUUID() };
    pending.current = input;
    try {
      const saved = await request<FeedbackPreferences>('/preferences', input, profileId);
      if (!alive.current) return false;
      pending.current = null; setValue(saved);
      if (!saved.promptsEnabled) { invitation.current++; if (!open) setMoment(null); }
      return true;
    } catch (failure) {
      if (alive.current) {
        if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) { pending.current = null; await load(); }
        setError('Could not confirm the preference change. Try again to save it.');
      }
      return false;
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  function invite(action: FeedbackMoment) {
    const version = ++invitation.current;
    // Read the account preference again to honor changes made in another browser.
    void load().then(saved => {
      if (alive.current && version === invitation.current && saved?.promptsEnabled) { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setMoment(action); setOpen(action === 'close'); }
    });
  }
  const dismiss = () => { setMoment(null); setOpen(false); requestAnimationFrame(() => { const target = returnFocus.current?.isConnected ? returnFocus.current : document.getElementById('content'); target?.focus({ preventScroll: true }); }); };
  return <LifecycleFeedbackContext.Provider value={invite}><PreferencesContext.Provider value={{ value, busy, error, reload: () => { pending.current = null; void load(); }, save }}>
    {children}
    {moment && open && <FeedbackDialog request={request} accountId={accountId} profileId={profileId} page="Project" moment={moment} onClose={dismiss} preferenceControl={<FeedbackPromptOptOut />} />}
    {moment === 'pause' && !open && <aside className="feedback-pause-prompt" aria-label="Optional pause feedback">
      <p role="status">Want to tell us why you paused?</p><p className="muted">Optional feedback, private to the MyLittleSwarm team.</p>
      <div className="feedback-actions"><Button onClick={() => setOpen(true)}>Give feedback</Button><Button onClick={dismiss}>Dismiss</Button></div>
      <FeedbackPromptOptOut />
    </aside>}
  </PreferencesContext.Provider></LifecycleFeedbackContext.Provider>;
}

function FeedbackPromptOptOut() {
  const preferences = useContext(PreferencesContext);
  if (!preferences) return null;
  return <div className="feedback-prompt-preference"><Button type="button" className="soft" disabled={preferences.busy || !preferences.value || !preferences.value.promptsEnabled} onClick={() => void preferences.save(false)}>{preferences.busy ? 'Saving preference…' : preferences.value?.promptsEnabled === false ? 'Feedback prompts turned off' : 'Don’t ask me again'}</Button>
    <p className="muted">For all projects.</p>
    {preferences.error && <p className="error" role="alert">{preferences.error}</p>}
  </div>;
}

