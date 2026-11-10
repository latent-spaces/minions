// Development-only controls for delayed reads/saves against the real production component.
// These synthetic settings do not contact any backend or start agents.
import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { NativeTaskSettings } from '@mlswarm/contracts';
import { TaskSettingsControl, type TaskSettingsApi } from '../src/ui/TaskSettingsControl';
import '../src/styles.css';
import '../src/ui/theme.css';

if (!import.meta.env.DEV || !['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('Local development only.');
type Request = { id: number; project: string; kind: 'read' | 'save'; input?: Parameters<TaskSettingsApi['save']>[0]; resolve: (value: NativeTaskSettings) => void; reject: (error: Error) => void };
let nextId = 0;
function Harness() {
  const [project, setProject] = useState('A'), [active, setActive] = useState(true), [mounted, setMounted] = useState(true);
  const [requests, setRequests] = useState<Request[]>([]), [history, setHistory] = useState<string[]>([]);
  const api = useMemo<TaskSettingsApi>(() => {
    const queue = (kind: Request['kind'], input?: Request['input']) => new Promise<NativeTaskSettings>((resolve, reject) => {
      const id = ++nextId;
      setHistory(rows => [...rows, `${project} ${kind} ${id}${input ? ` ${JSON.stringify(input)}` : ''}`]);
      setRequests(rows => [...rows, { id, project, kind, input, resolve, reject }]);
    });
    return { get: () => queue('read'), save: input => queue('save', input) };
  }, [project]);
  const finish = (request: Request, enabled: boolean | 'network' | 'refused') => {
    setRequests(rows => rows.filter(row => row.id !== request.id));
    if (enabled === 'network') request.reject(new TypeError('Synthetic network failure'));
    else if (enabled === 'refused') request.reject(Object.assign(new Error('Synthetic stale setting revision'), { status: 409 }));
    else request.resolve({ enabled, revision: request.input ? request.input.expectedRevision + 1 : request.project === 'A' ? 4 : 20 });
  };
  return <main style={{ maxWidth: 900, margin: '0 auto', padding: 24 }}>
    <h1>Synthetic task settings checks</h1>
    <p>No backend calls. Resolve requests below in any order to check loading, recovery and project isolation.</p>
    <p>Current project: <strong>{project}</strong></p>
    <div className="k42-task-actions">
      <button onClick={() => setProject(value => value === 'A' ? 'B' : 'A')}>Switch project</button>
      <button onClick={() => setActive(value => !value)}>{active ? 'Deactivate' : 'Activate'} settings</button>
      <button onClick={() => setMounted(value => !value)}>{mounted ? 'Unmount' : 'Mount'} settings</button>
    </div>
    {mounted && <TaskSettingsControl api={api} active={active} onSaved={saved => setHistory(rows => [...rows, `Saved callback ${project}: ${saved.enabled ? 'On' : 'Off'}`])} />}
    <h2>Pending requests</h2>
    <ul>{requests.map(request => <li key={request.id} style={{ marginBottom: 12 }}>
      <strong>{request.project} {request.kind} {request.id}</strong>
      <div className="k42-task-actions">
        <button onClick={() => finish(request, false)}>Resolve {request.id} Off</button>
        <button onClick={() => finish(request, true)}>Resolve {request.id} On</button>
        <button onClick={() => finish(request, 'network')}>Reject {request.id} network</button>
        <button onClick={() => finish(request, 'refused')}>Refuse {request.id}</button>
      </div>
    </li>)}</ul>
    <h2>Request and callback history</h2>
    <ol>{history.map((row, index) => <li key={index}><code>{row}</code></li>)}</ol>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
