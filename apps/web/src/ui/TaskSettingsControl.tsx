import { useEffect, useId, useRef, useState } from 'react';
import type { NativeTaskSettings as Settings } from '@mlswarm/contracts';
import { isSettledRefusal } from '../task-model';
import { Button } from './Button';
import { SettingToggle } from './SettingToggle';
import './project-tasks.css';

export type TaskSettingsApi = { get(): Promise<Settings>; save(input: { clientRequestId: string; expectedRevision: number; enabled: boolean }): Promise<Settings> };
/** Owner-only task setting; the service enforces current membership and project state. */
export function TaskSettingsControl({ api, active, readOnly = false, onSaved, feature = 'tasks' }: { feature?: 'tasks' | 'teams'; api: TaskSettingsApi; active: boolean; readOnly?: boolean; onSaved?: (value: Settings) => void }) {
  const title = feature === 'teams' ? 'Teams' : 'Tasks', singular = feature === 'teams' ? 'team' : 'task';
  type Save = Parameters<TaskSettingsApi['save']>[0];
  type State = { api: TaskSettingsApi; saved: Settings | null; pending: Save | null; busy: boolean; loading: boolean; error: string };
  const initial = (): State => ({ api, saved: null, pending: null, busy: false, loading: true, error: '' });
  const [state, setState] = useState<State>(initial);
  // Mask the old project synchronously, before effects or an earlier request can paint it.
  const value = state.api === api ? state : initial();
  const context = useRef({ api, active }); context.current = { api, active };
  const generation = useRef(0), id = useId(), onSavedRef = useRef(onSaved); onSavedRef.current = onSaved;
  const confirmed = useRef({ api, needsCurrentRead: false });
  if (confirmed.current.api !== api) confirmed.current = { api, needsCurrentRead: false };
  const current = (mine: number) => generation.current === mine && context.current.api === api && context.current.active;
  const read = () => {
    const mine = ++generation.current;
    setState(previous => ({ ...(previous.api === api ? previous : initial()), saved: null, loading: true, busy: false, error: '' }));
    api.get().then(saved => {
      if (!current(mine)) return;
      setState(previous => ({ ...previous, saved, loading: false, error: '' }));
      if (confirmed.current.needsCurrentRead) {
        confirmed.current.needsCurrentRead = false;
        onSavedRef.current?.(saved);
      }
    }, error => {
      if (current(mine)) setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : `Could not read ${singular} settings.` }));
    });
  };
  useEffect(() => {
    if (active) read();
    return () => { generation.current++; };
  }, [active, api]);
  const send = (pending: Save) => {
    const mine = ++generation.current;
    // Keep the exact attempted payload before sending: an uncertain reply must replay it unchanged.
    setState(previous => ({ ...previous, pending, busy: true, error: '' }));
    api.save(pending).then(() => {
      if (!current(mine)) return;
      // A stable retry can return an older receipt after another tab changed
      // the feature. Its success settles this intent, never the current setting.
      confirmed.current.needsCurrentRead = true;
      setState({ api, saved: null, pending: null, busy: false, loading: true, error: '' });
      api.get().then(saved => {
        if (!current(mine)) return;
        confirmed.current.needsCurrentRead = false;
        setState({ api, saved, pending: null, busy: false, loading: false, error: '' });
        onSavedRef.current?.(saved);
      }, error => {
        if (!current(mine)) return;
        setState({ api, saved: null, pending: null, busy: false, loading: false,
          error: `Change confirmed, but current ${singular} settings could not be read. ${error instanceof Error ? error.message : 'Try again.'}` });
      });
    }, error => {
      if (!current(mine)) return;
      if (isSettledRefusal(error)) {
        setState(previous => ({ ...previous, pending: null, saved: null, busy: false, error: error instanceof Error ? error.message : `Could not save ${singular} settings.` }));
      } else {
        setState(previous => ({ ...previous, busy: false, error: 'Change not confirmed. Retry to confirm it.' }));
      }
    });
  };
  const { saved, pending, busy, loading, error } = value;
  const enabled = pending?.enabled ?? saved?.enabled ?? false;
  return <div className="settings-section" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`} className="visually-hidden">{title}</h3>
    {loading ? <p className="muted" role="status">Loading {singular} settings…</p> : saved && <SettingToggle
      label={`Use ${feature} in this project`} value={enabled} disabled={!active || readOnly || busy || !!pending}
      onChange={enabled => send({ clientRequestId: crypto.randomUUID(), expectedRevision: saved.revision, enabled })} />}
    <p className="muted">{feature === 'teams' ? 'Off hides the Teams tab. Teams, memberships and history are kept. Agents keep working.' : 'Off hides the Tasks tab. Tasks, comments and assignments are kept. Agents keep working.'}</p>
    {error && <p role="alert" className="error">{error}</p>}
    {!loading && (pending ? <Button disabled={!active || readOnly || busy} onClick={() => send(pending)}>Retry</Button> : !saved && <Button disabled={!active} onClick={read}>Try again</Button>)}
  </div>;
}
