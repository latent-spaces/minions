import type { SessionUser } from './session-identity';
import { useRef, useState } from 'react';
import { owner } from './api';
import type { Route } from './route';
import { Button } from './ui/Button';
import { confirmAction } from './ui/Confirm';
import { useComputers, type Computer } from './ui/ComputerSetup';
import { ConnectionList } from './ui/ConnectionList';
import { InfoTip } from './ui/InfoTip';
import { PathHeading } from './ui/PathHeading';
import { notify } from './ui/Toast';

// App-wide settings, linked at the foot of the menu (owner, 11 November 2026). The engine accepts only this
// computer, so its connections are the shared service Claude Code and Codex use here.
export function AppSettings({ user, active, refreshKey, go, retry }: {
  user: SessionUser; active: boolean; refreshKey: number; go: (to: Route) => void; retry: () => void;
}) {
  const { computers, error: loadError } = useComputers(user, active, refreshKey, true);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const locked = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  async function revoke(connection: Computer) {
    if (locked.current) return;
    locked.current = true;
    try {
      if (!await confirmAction(`${connection.clientName} and every agent working through it lose access in all your projects. Agents stop once it gets this; if it's offline, that happens when it next connects.`, 'Revoke', `Revoke ${connection.clientName}?`)) return;
      setBusy(connection.id); setError(null);
      await owner(user, `/computers/${connection.id}/revoke`, {});
      notify('Connection and its agents revoked.');
      heading.current?.focus();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not revoke it. Try again.'); }
    finally { locked.current = false; setBusy(null); retry(); }
  }
  return <section className="k42-reveal" aria-labelledby="app-settings-title">
    <div className="project-heading"><PathHeading title="Settings" go={go} id="app-settings-title" headingRef={heading} tabIndex={-1} /></div>
    <div className="k42-connections-title"><h2>Connections</h2><InfoTip label="connections">The MyLittleSwarm service that Claude Code and Codex use on this computer, once you approve it. Revoking it stops their agents in every project.</InfoTip></div>
    {loadError && <div role="alert"><p className="error">Could not refresh your connections: {loadError}</p>{computers !== null && <p className="muted">Showing the last loaded connections.</p>}<Button onClick={retry}>Try again</Button></div>}
    {computers === null ? !loadError && <p className="muted" role="status">Loading connections…</p>
      : <ConnectionList connections={computers} busy={busy} revoke={connection => void revoke(connection)} />}
    {error && <div role="alert"><p className="error">{error}</p></div>}
  </section>;
}
