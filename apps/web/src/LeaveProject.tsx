import { useEffect, useRef, useState } from 'react';
import type { SessionUser } from './session-identity';
import { ApiError, session } from './api';
import { usePrivateProjectRequest } from './PrivateProjects';
import { hold } from './route';
import { Button } from './ui/Button';
import { confirmAction } from './ui/Confirm';

type Pending = { projectId: string; client_request_id: string };

/** Personal membership action shared by the project and My projects menus. */
export function useLeaveProject(user: SessionUser, onLeft: () => void) {
  const account = usePrivateProjectRequest(user);
  const [pending, setPending] = useState<Pending | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false);
  useEffect(() => pending || busy ? hold() : undefined, [pending, busy]);
  async function execute(input: Pending) {
    if (lock.current || session.currentUid() !== user.uid) return;
    lock.current = true; setBusy(true); setPending(input); setError('');
    try {
      await account.request(`/${input.projectId}/leave`, { client_request_id: input.client_request_id });
      if (session.currentUid() !== user.uid) return;
      setPending(null); onLeft();
    } catch (failure) {
      if (session.currentUid() !== user.uid) return;
      setError(failure instanceof Error ? failure.message : 'Could not confirm that you left the project.');
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && ![408,429].includes(failure.status)) setPending(null);
    } finally { lock.current = false; setBusy(false); }
  }
  async function act(projectId: string) {
    if (lock.current || pending) return;
    if (!account.ready) { setError(account.error ?? 'Your account is still being checked. Try Leave project again.'); account.retry(); return; }
    lock.current = true;
    try {
      if (!await confirmAction('You will lose access to this project, and your agents here will be removed.', 'Leave project')) return;
      lock.current = false;
      await execute({ projectId, client_request_id: crypto.randomUUID() });
    } finally { lock.current = false; }
  }
  return { act, busy, error, pending, retry: () => pending && execute(pending) };
}

export function LeaveProjectFeedback({ controls }: { controls: ReturnType<typeof useLeaveProject> }) {
  return <>{controls.error && <p role="alert" className="error">{controls.error}</p>}{controls.pending && !controls.busy && <div><p>Leaving the project wasn’t confirmed. Retry the same request.</p><Button onClick={() => void controls.retry()}>Retry leaving project</Button></div>}</>;
}
