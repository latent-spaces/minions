import type { SessionUser } from '../session-identity';
import { useRef, useState } from 'react';
import { owner } from '../api';
import { Button } from './Button';
import { confirmAction } from './Confirm';
import { useComputers, type Computer } from './ComputerSetup';
import { ConnectionList } from './ConnectionList';
import { InfoTip } from './InfoTip';
import { notify } from './Toast';

// A card in project Settings (owner, 11 November 2026). The engine accepts only this computer, so its connections are
// the shared service Claude Code and Codex use here; a connection serves every project, so Revoke says so.
export function Connections({ user, active, refreshKey, retry }: { user: SessionUser; active: boolean; refreshKey: number; retry: () => void }) {
  const { computers, error: loadError } = useComputers(user, active, refreshKey, true);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const locked = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  async function revoke(connection: Computer) {
    if (locked.current) return;
    locked.current = true;
    try {
      if (!await confirmAction(`${connection.clientName} and every agent working through it lose access in all your projects, not only this one. Agents stop once it gets this; if it's offline, that happens when it next connects.`, 'Revoke', `Revoke ${connection.clientName}?`)) return;
      setBusy(connection.id); setError(null);
      await owner(user, `/computers/${connection.id}/revoke`, {});
      notify('Connection and its agents revoked.');
      heading.current?.focus();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not revoke it. Try again.'); }
    finally { locked.current = false; setBusy(null); retry(); }
  }
  return <section className="settings-card" aria-labelledby="settings-connections-title">
    <div className="settings-group-title k42-connections-title"><h3 id="settings-connections-title" ref={heading} tabIndex={-1}>Connections</h3>
      <InfoTip label="connections">The Minions service that Claude Code and Codex use on this computer, once you approve it. It serves all your projects: revoking it stops their agents everywhere.</InfoTip></div>
    {loadError && <div role="alert"><p className="error">Could not refresh your connections: {loadError}</p>{computers !== null && <p className="muted">Showing the last loaded connections.</p>}<Button onClick={retry}>Try again</Button></div>}
    {computers === null ? !loadError && <p className="muted" role="status">Loading connections…</p>
      : <ConnectionList connections={computers} busy={busy} revoke={connection => void revoke(connection)} />}
    {error && <div role="alert"><p className="error">{error}</p></div>}
  </section>;
}
