import type { SessionUser } from './session-identity';
import { useRef, useState } from 'react';
import { owner } from './api';
import type { Route } from './route';
import { Button } from './ui/Button';
import { confirmAction } from './ui/Confirm';
import { useComputers, type Computer } from './ui/ComputerSetup';
import { MyComputersPage } from './ui/MyComputersPage';
import { PathHeading } from './ui/PathHeading';
import { notify } from './ui/Toast';

export function MyComputers({ user, active, refreshKey, go, retry }: {
  user: SessionUser; active: boolean; refreshKey: number; go: (to: Route) => void; retry: () => void;
}) {
  const { computers, error: loadError } = useComputers(user, active, refreshKey, true);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const locked = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  async function revoke(computer: Computer) {
    if (locked.current) return;
    locked.current = true;
    try {
      if (!await confirmAction('This computer and all agents connected through it will lose MyLittleSwarm access across all projects. Background work stops when the computer receives the revocation. An offline computer must reconnect before it can receive it.', 'Revoke access', `Revoke access for ${computer.clientName}?`)) return;
      setBusy(computer.id); setError(null);
      await owner(user, `/computers/${computer.id}/revoke`, {});
      notify('Computer and connected agents revoked.');
      heading.current?.focus();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not revoke access. Try again.'); }
    finally { locked.current = false; setBusy(null); retry(); }
  }
  return <section className="k42-reveal" aria-labelledby="my-computers-title">
    <div className="project-heading"><PathHeading title="My computers" go={go} id="my-computers-title" headingRef={heading} tabIndex={-1} /></div>
    <p className="muted">Revoking a computer also revokes its agents.</p>
    {loadError && <div role="alert"><p className="error">Could not refresh your computers: {loadError}</p>{computers !== null && <p className="muted">Showing the last loaded connections.</p>}<Button onClick={retry}>Try again</Button></div>}
    {computers === null ? !loadError && <p className="muted" role="status">Loading computers…</p>
      : <MyComputersPage computers={computers} busy={busy} revoke={computer => void revoke(computer)} />}
    {error && <div role="alert"><p className="error">{error}</p></div>}
  </section>;
}
