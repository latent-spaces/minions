import { Button } from './Button';
import { COMPUTER_APPROVED } from './ComputerSetup';
import { useCallback, useEffect, useState } from 'react';
import type { SessionUser } from '../session-identity';
import { owner } from '../api';

type OwnerReview = { requestId: string; clientName: string; status: 'pending' | 'approved' | 'expired' | 'cancelled'; expiresAt: number; connectionExpiresAt: number | null; verificationCode: string; personName?: string; email?: string };

// The one browser approval: a person approves a computer, which then connects their agents.
export function OwnerConnectionApproval({ user, requestId }: { user: SessionUser; requestId: string }) {
  const [review, setReview] = useState<OwnerReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useCallback(async (approve = false) => {
    return owner<OwnerReview>(user, `/connect/${encodeURIComponent(requestId)}/${approve ? 'approve' : 'review'}`, approve ? { approved: true } : undefined);
  }, [requestId, user]);
  useEffect(() => { let cancelled = false; setReview(null); setError(null);
    request().then(data => { if (!cancelled) setReview(data); }, reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not load this request.'); });
    return () => { cancelled = true; };
  }, [request, user]);
  async function approve() { setBusy(true); setError(null); try {
    const approved = await request(true);
    // Approval keeps the person on this page; the tab they came from hears about it and carries on.
    if (approved.status === 'approved') { try { localStorage.setItem(COMPUTER_APPROVED, String(Date.now())); } catch { /* the other tab can still Check again */ } }
    setReview(previous => ({ ...previous!, ...approved }));
  } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not approve this request.'); } finally { setBusy(false); } }
  // Once approved there is nothing left to do here: the tab the person came from carries on by itself.
  if (review?.status === 'approved') return <ApprovePage>
    <div role="status" className="k42-approve-done">
      <span className="k42-approve-check" aria-hidden="true"><CircleCheck size={30} /></span>
      <h1 id="owner-connection-title">This computer is approved</h1>
      <p>Go back to your coding agent or terminal to complete setup.</p>
      <p className="k42-approve-muted">You can close this page.</p>
    </div>
  </ApprovePage>;
  return <ApprovePage>
    <h1 id="owner-connection-title">Approve this computer</h1>
    {!review && !error && <p role="status">Loading your request…</p>}
    {review && <>
      <p>Allow <strong>{review.clientName}</strong> on this computer to add your agents and manage your projects as <strong>{review.personName ?? user.displayName ?? user.email}</strong>.</p>
      <dl><dt>Request check</dt><dd><strong>{review.verificationCode}</strong></dd><dt>Approval expires</dt><dd>{new Date(review.expiresAt).toLocaleString()}</dd><dt>Access duration</dt><dd>90 days, or until you revoke it in My computers</dd></dl>
      {review.status === 'pending' && <p>Check that this code matches your coding agent or terminal before approving.</p>}
      <p>Once approved, this computer can:</p><ul><li><strong>Add your own agents to any project you belong to, now and later, without asking you again.</strong> Your coding agent still asks you before an agent starts work.</li><li>Read your proposals, projects and their status.</li><li>Create private projects when you ask, without public proposal review.</li><li>Start projects you own once they are ready.</li><li>Manage moderator and admin roles within projects you own.</li></ul>
      <p className="muted">It reaches only projects you belong to and can’t approve anyone else’s agents. Your coding agent keeps asking for your OK as usual.</p>
      {review.status === 'pending' ? <div className="actions"><Button className="primary" disabled={busy} onClick={() => void approve()}><ShieldCheck size={18} aria-hidden="true" />{busy ? 'Approving…' : 'Approve this computer'}</Button></div>
        : <p role="status">This request {review.status === 'expired' ? 'expired' : 'was cancelled'}. Start the approval again from your coding agent.</p>}
    </>}
    {error && <p role="alert" className="error">{error}</p>}
    <Button className="soft" disabled={busy} onClick={() => { void request().then(data => { setReview(data); setError(null); }, reason => setError(reason instanceof Error ? reason.message : 'Could not refresh this request.')); }}>Refresh request</Button>
  </ApprovePage>;
}
import { Bot, CircleCheck, Laptop, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { BrandLogo } from './BrandLogo';
import './approve-computer.css';

/** A calm, centred card for the browser step of connecting a computer (owner, 21 October 2026). */
function ApprovePage({ children }: { children: ReactNode }) {
  return <div className="k42-approve-page"><BrandLogo />
    <section className="k42-approve-card" aria-labelledby="owner-connection-title">
      <div className="k42-approve-art" aria-hidden="true"><span className="k42-approve-device"><Laptop size={26} /></span><span className="k42-approve-link" /><span className="k42-approve-device k42-tone-butter"><Bot size={26} /></span></div>
      {children}
    </section></div>;
}
