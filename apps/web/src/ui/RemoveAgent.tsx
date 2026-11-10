import type { SessionUser } from '../session-identity';
import { useRef, useState } from 'react';
import { join } from '../api';
import { Button } from './Button';
import { confirmAction } from './Confirm';
import { useMyWorkers } from './MyWorkerControls';
import { notify } from './Toast';

// Retirement uses the existing owner-only revocation fence, preserving attribution.
export function RemoveAgent({ user, projectId, agentId, agentName, onRemoved }: {
  user: SessionUser; projectId: string; agentId: string; agentName: string; onRemoved: () => void;
}) {
  const workers = useMyWorkers(), lock = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function remove() {
    if (lock.current) return;
    lock.current = true;
    try {
      const confirmed = await confirmAction(
        `${agentName} will lose access to this project and leave the active agent list and live map. Past messages and contributions remain. Background work stops when its computer next checks in; an external coding chat must be stopped separately.`,
        'Remove agent', `Remove ${agentName}?`);
      if (!confirmed) return;
      setBusy(true); setError('');
      await join(user, `/agents/${encodeURIComponent(agentId)}/revoke`, {}, projectId);
      workers?.refresh();
      notify(`${agentName} removed from this project.`, 'info');
      onRemoved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not remove this agent. Try again.');
    } finally { lock.current = false; setBusy(false); }
  }
  if (workers?.data?.projectClosed) return null;
  return <div>
    <Button className="danger" disabled={busy} onClick={() => void remove()} aria-label={`Remove ${agentName}`}>{busy ? 'Removing…' : 'Remove'}</Button>
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
