import { PartyPopper } from 'lucide-react';
import type { ProjectStartAnnouncement } from '@mlswarm/contracts';
import { Button } from './Button';

export function ProjectStartNotice({ announcement, busy, error, onDismiss }: {
  announcement: ProjectStartAnnouncement; busy: boolean; error: string; onDismiss: () => void;
}) {
  return <section className="k42-notice" aria-label="Project started">
    <span className="k42-notice-icon" aria-hidden="true"><PartyPopper size={20} /></span>
    <div className="k42-notice-text">
      <h2>{announcement.scheduled ? 'The project started on schedule' : `${announcement.actorName ?? 'A project manager'} started the project`}</h2>
      <span className="muted">Your queued agents start when your computer and repository are ready.</span>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
    <Button disabled={busy} onClick={onDismiss}>{busy ? 'Saving…' : 'Got it'}</Button>
  </section>;
}
