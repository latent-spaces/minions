import { useEffect, useRef, useState } from 'react';
import type { SessionUser } from './session-identity';
import type { ProjectStartAnnouncement as Announcement } from '@mlswarm/contracts';
import { session, privateProjects } from './api';
import { ProjectStartNotice } from './ui/ProjectStartNotice';
import { notify } from './ui/Toast';

/** The server owns acknowledgement across devices; displaying this starts no agent. */
export function ProjectStartAnnouncement({ user, profileId, projectId, announcement, active, onUpdated }: {
  user: SessionUser; profileId: string; projectId: string; announcement: Announcement; active: boolean; onUpdated: () => void;
}) {
  const [dismissed, setDismissed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false);
  // StrictMode replays effects; both subscribers must share the one server claim.
  const claim = useRef<Promise<{ celebrate: boolean }> | null>(null);
  const celebrated = useRef(false);
  useEffect(() => {
    if (!active || dismissed || announcement.dismissed || announcement.seen || session.currentUid() !== user.uid) return;
    let live = true, requested = false, celebrate = false;
    const see = () => {
      if (!live || document.visibilityState !== 'visible' || session.currentUid() !== user.uid) return;
      if (celebrate && !celebrated.current) { celebrate = false; celebrated.current = true; notify('The project has started!'); }
      if (requested) return;
      requested = true;
      claim.current ??= privateProjects<{ celebrate: boolean }>(user, profileId, `/${projectId}/start-announcement`, { revision: announcement.revision, action: 'seen' });
      void claim.current.then(result => {
        if (live && result.celebrate) { celebrate = true; see(); }
      }).catch(() => { /* The announcement remains available even if celebration cannot be claimed. */ });
    };
    see(); document.addEventListener('visibilitychange', see);
    return () => { live = false; document.removeEventListener('visibilitychange', see); };
  }, [user, profileId, projectId, announcement.revision, announcement.seen, announcement.dismissed, active, dismissed]);
  async function dismiss() {
    if (lock.current || session.currentUid() !== user.uid) return;
    lock.current = true; setBusy(true); setError('');
    try {
      await privateProjects(user, profileId, `/${projectId}/start-announcement`, { revision: announcement.revision, action: 'dismiss' });
      if (session.currentUid() === user.uid) { setDismissed(true); onUpdated(); }
    } catch (failure) { if (session.currentUid() === user.uid) setError(failure instanceof Error ? failure.message : 'Could not save dismissal. Try again.'); }
    finally { lock.current = false; setBusy(false); }
  }
  return dismissed || announcement.dismissed || !active ? null : <ProjectStartNotice announcement={announcement} busy={busy} error={error} onDismiss={() => void dismiss()} />;
}
