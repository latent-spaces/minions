import { useEffect, useId, useState } from 'react';
import type { SessionUser } from '../session-identity';
import type { AgentEnvironmentView } from '@mlswarm/contracts';
import { ApiError, session, projects } from '../api';
import { Button } from './Button';
import { CloseButton } from './CloseButton';
import { EmptyState } from './EmptyState';
import { FileSearch } from 'lucide-react';

const statusLabel = { discovered:'Found · loading unverified', missing:'Not found', unreadable:'Not inspected', supplied:'Supplied by MyLittleSwarm · native loading unverified' };
// Opened from the agent page's ⋯ menu (owner, 12 November 2026).
export function AgentEnvironment({ user, projectId, agentId, active, tick, onClose }: { user:SessionUser; projectId:string; agentId:string; active:boolean; tick:number; onClose:() => void }) {
  const id = useId();
  const [saved, setSaved] = useState<AgentEnvironmentView | null>(null), [error, setError] = useState('');
  const [denied, setDenied] = useState(false), [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!active || session.currentUid() !== user.uid) return;
    let cancelled = false;
    projects<AgentEnvironmentView>(user, `/${projectId}/agents/${agentId}/environment`).then(value => {
      if (cancelled || session.currentUid() !== user.uid) return;
      setSaved(value); setError(''); setDenied(false);
    }, reason => {
      if (cancelled || session.currentUid() !== user.uid) return;
      if (reason instanceof ApiError && [401,403].includes(reason.status)) { setDenied(true); setSaved(null); }
      setError(reason.message);
    });
    return () => { cancelled = true; };
  }, [user.uid, projectId, agentId, active, tick, retry]);
  if (denied || session.currentUid() !== user.uid) return null;
  const report = saved?.report;
  return <section className="agent-panel" aria-labelledby={id}>
    <div className="agent-section-line"><h3 id={id}>Local environment</h3><CloseButton label="Close local environment" onClick={onClose} /></div>
    <p className="agent-help">Only you see this. It lists the instruction files the connector found, not what the coding agent loaded.</p>
    {error && <p role="alert" className="error">Could not read the saved environment: {error}</p>}
    {!saved && !error && <p role="status">Loading environment…</p>}
    {saved && !report && <EmptyState icon={FileSearch} size="compact" title="No report yet">Nothing has been reported for this agent.</EmptyState>}
    {report && <>
      <dl className="agent-details-list">
        <div><dt>Client</dt><dd>{report.client === 'unknown' ? 'Unknown' : report.client === 'claude' ? 'Claude Code' : 'Codex'}</dd></div>
        <div><dt>Mode</dt><dd>{report.mode === 'background_worker' ? 'Background worker' : 'Current coding chat'}</dd></div>
        <div><dt>Working folder</dt><dd>{report.workingFolder}</dd></div>
        <div><dt>Connector</dt><dd>{report.connectorVersion}</dd></div>
        <div><dt>Report received</dt><dd>{saved.receivedAt === null ? 'Unknown' : new Date(saved.receivedAt).toLocaleString()}</dd></div>
      </dl>
      <details><summary>Instruction files ({report.sources.length})</summary>
        <ul className="list">{report.sources.map((source, index) => <li key={source.path + ':' + index}>
          <strong>{source.scope}</strong><p className="body">{source.path}</p>
          <p className="agent-help">{statusLabel[source.status]}</p>
          {source.sha256 && <details><summary>File version (SHA-256)</summary><p className="body"><code>{source.sha256}</code></p></details>}
        </li>)}</ul>
      </details>
      {report.truncated && <p className="warn">The bounded scan stopped early. This is a partial inventory.</p>}
    </>}
    <Button className="soft" type="button" onClick={() => setRetry(value => value + 1)}>Refresh saved report</Button>
  </section>;
}
