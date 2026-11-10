import { subscribeRealtime, RECONCILE_MS } from '../realtime';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { SessionUser } from '../session-identity';
import type { NotificationPage, KarmaNotification } from '@mlswarm/contracts';
import { Bell, Inbox, ShieldAlert, X } from 'lucide-react';
import { ApiError, ownOwner, session } from '../api';
import { projectRoute, type Route } from '../route';
import { NavLink } from '../shared';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { AgentAvatar } from './AgentAvatar';
import { bellBadge, bellLabel, defaultBellTab, newestFirst, shortAge, moderationAction, type BellTab } from './notifications-bell';
import { useAnchoredPopover } from './use-anchored-popover';
import { useInvitedProfile } from './use-invited-profile';
import { useNeedsYouPage } from './use-needs-you-page';
import './notifications-bell.css';

// A refused profile is looked up again from Try again, as the Needs you inbox does.
const refused = (failure: unknown): failure is ApiError => failure instanceof ApiError && [401, 403, 404].includes(failure.status);

/** Bell with two tabs: Needs you (open requests, cleared only by answering) and Updates
 * (private unread notices; open, clear one, or clear all, which marks them read on the server). */
export function NotificationsBell({ user, active, go }: { user: SessionUser; active: boolean; go: (route: Route) => void }) {
  const { profileId, error: accessError, retry: checkAccess, deny } = useInvitedProfile(user);
  // Open requests are shared with the Needs you inbox; this bell reads only the notices itself.
  const requests = useNeedsYouPage(user, profileId, '?status=open', { enabled: active }), page = requests.data ?? null;
  // refetch() runs even while the read is off, so it is asked only once there is a profile to read for.
  const refreshRequests = () => { if (active && profileId) void requests.refetch(); };
  const [notices, setNotices] = useState<NotificationPage | null>(null), [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  const [tab, setTab] = useState<BellTab | null>(null);
  const noticeScope = useMemo(() => ({ revision: 0, mutating: 0 }), [user.uid, profileId]);
  const activeScope = useRef(noticeScope); activeScope.current = noticeScope;
  const headingId = useId(), tabsId = useId();
  const { close, triggerProps, panelProps } = useAnchoredPopover<HTMLElement>({ align: 'end', onOpen: () => { setTab(null); setAsked(n => n + 1); refreshRequests(); } });
  useEffect(() => { setNotices(null); setBusy(null); }, [user.uid, profileId]);
  useEffect(() => { if (refused(requests.error)) deny(requests.error); }, [requests.error, deny]);
  useEffect(() => {
    if (!profileId || !active) return;
    let live = true, reading = false, again = false;
    async function load() {
      if (reading) { again = true; return; }
      if (noticeScope.mutating || document.visibilityState === 'hidden') return;
      reading = true;
      const revision = noticeScope.revision;
      try {
        const notifications = await ownOwner<NotificationPage>(user, profileId!, '/notifications');
        if (live && activeScope.current === noticeScope && revision === noticeScope.revision) { setNotices(notifications); setError(null); }
      } catch (failure) {
        if (!live || activeScope.current !== noticeScope || revision !== noticeScope.revision) return;
        if (refused(failure)) { setNotices(null); deny(failure); }
        else setError((failure as Error).message);
      } finally { reading = false; if (again && live) { again = false; void load(); } }
    }
    void load();
    const timer = setInterval(() => void load(), RECONCILE_MS);
    const stop = subscribeRealtime(user, undefined, topics => { if (topics.includes('needs-you')) void load(); });
    return () => { live = false; clearInterval(timer); stop(); };
  }, [user, profileId, active, asked, deny, noticeScope]);
  const count = page && notices ? page.items.length + notices.items.length : null, more = page?.next != null || notices?.next != null;
  const badge = count === null ? null : bellBadge(count, more);
  const problem = accessError ?? error ?? (requests.error && !refused(requests.error) ? requests.error.message : null);
  const rows = page ? newestFirst(page.items) : [];
  const shown: BellTab = tab ?? defaultBellTab(rows.length);
  const now = Date.now();
  const same = () => session.currentUid() === user.uid && activeScope.current === noticeScope;
  const drop = (id: string) => setNotices(current => current ? { ...current, items: current.items.filter(row => row.id !== id) } : current);
  async function markRead(notice: KarmaNotification, navigate: boolean) {
    if (!profileId || busy || noticeScope.mutating || !same()) return; setBusy(notice.id); noticeScope.revision++; noticeScope.mutating++;
    try {
      await ownOwner(user, profileId, `/notifications/${notice.id}/read`, {}); if (!same()) return; drop(notice.id);
      if (navigate) { close(); go(projectRoute(notice.projectId, 'agents', notice.agentId, null, 'all')); }
    } catch (failure) { if (same()) setError((failure as Error).message); } finally { noticeScope.revision++; noticeScope.mutating--; if (same()) { setBusy(null); setAsked(n => n + 1); } }
  }
  async function markAll() {
    if (!profileId || busy || noticeScope.mutating || !same()) return; setBusy('all'); noticeScope.revision++; noticeScope.mutating++;
    try { await ownOwner(user, profileId, '/notifications/read-all', {}); if (same()) setNotices({ items: [], next: null }); }
    catch (failure) { if (same()) setError((failure as Error).message); } finally { noticeScope.revision++; noticeScope.mutating--; if (same()) { setBusy(null); setAsked(n => n + 1); } }
  }
  async function moreNotices() {
    if (!profileId || !notices?.next || busy || noticeScope.mutating || !same()) return;
    // Paging owns the displayed notice window too: an earlier first-page read
    // must not replace the older page after it arrives.
    setBusy('more'); noticeScope.revision++; noticeScope.mutating++;
    try { const next = await ownOwner<NotificationPage>(user, profileId, '/notifications?cursor=' + encodeURIComponent(notices.next)); if (!same()) return; setNotices(current => current ? { items: [...new Map([...current.items, ...next.items].map(row => [row.id, row])).values()], next: next.next } : next); setError(null); }
    catch (failure) { if (same()) setError((failure as Error).message); }
    finally { noticeScope.revision++; noticeScope.mutating--; if (same()) setBusy(null); }
  }
  const open = (to: Route) => { close(); go(to); };
  const tabs: { id: BellTab; label: string; count: number | null }[] = [
    { id: 'needs-you', label: 'Needs you', count: page ? page.items.length : null },
    { id: 'updates', label: 'Updates', count: notices ? notices.items.length : null },
  ];
  function arrow(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next: BellTab = event.key === 'Home' ? 'needs-you' : event.key === 'End' ? 'updates' : shown === 'needs-you' ? 'updates' : 'needs-you';
    setTab(next); document.getElementById(`${tabsId}-${next}`)?.focus();
  }
  return <>
    <button type="button" {...triggerProps} className="k42-top-icon k42-bell" aria-label={bellLabel(count, more)} title="Notifications">
      <Bell size={20} aria-hidden="true" />{badge && <span className="k42-bell-badge" aria-hidden="true">{badge}</span>}
    </button>
    <section {...panelProps} className={`${panelProps.className} k42-bell-panel`} aria-labelledby={headingId}>
      <div className="k42-bell-header">
        <h2 id={headingId} className="k42-bell-heading">Notifications</h2>
        {shown === 'updates' && notices && notices.items.length > 0 && !problem && <button type="button" className="k42-bell-text-button" disabled={busy !== null} onClick={() => void markAll()}>Clear all</button>}
      </div>
      <div role="tablist" aria-label="Notification type" className="k42-bell-tabs" onKeyDown={arrow}>
        {tabs.map(item => <button key={item.id} type="button" role="tab" id={`${tabsId}-${item.id}`} aria-selected={shown === item.id} aria-controls={`${tabsId}-panel`} tabIndex={shown === item.id ? 0 : -1} className="k42-bell-tab" onClick={() => setTab(item.id)}>
          {item.label}{!!item.count && <span className="k42-bell-tab-count">{item.count}{item.id === 'needs-you' ? (page?.next ? '+' : '') : (notices?.next ? '+' : '')}</span>}
        </button>)}
      </div>
      <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${shown}`} className="k42-bell-tabpanel">
        {problem ? <div role="alert" className="k42-bell-problem"><p>{problem}</p><Button type="button" className="k42-bell-quiet" onClick={() => { if (accessError) checkAccess(); else { setAsked(n => n + 1); if (requests.error) refreshRequests(); } }}>Try again</Button></div>
          : !page || !notices ? <p role="status" className="k42-bell-status">Checking notifications…</p>
          : shown === 'needs-you'
            ? rows.length === 0 ? <EmptyState icon={Inbox} size="compact" title="Nothing needs you right now." />
              : <ul className="k42-bell-list">{rows.map(request => <li key={request.id}>
                <NavLink to={projectRoute(request.projectId, 'needs-you')} go={open} className="k42-bell-row">
                  <span className="k42-bell-unread" aria-hidden="true" />
                  <AgentAvatar name={request.agentName} id={request.agentId} ownerId={profileId} size={32} decorative />
                  <span className="k42-bell-text">
                    <span className="k42-bell-sentence"><strong>{request.agentName}</strong> needs your answer: {request.title}</span>
                    <small>{request.projectTitle}</small>
                  </span>
                  <time className="k42-bell-age" dateTime={new Date(request.createdAt).toISOString()}>{shortAge(request.createdAt, now)}</time>
                </NavLink>
              </li>)}</ul>
            : <>{notices.items.length === 0 ? <EmptyState icon={Inbox} size="compact" title={notices.next ? "More updates are available" : "You're all caught up"} />
              : <ul className="k42-bell-list">{notices.items.map(notice => <li key={notice.id} className="k42-bell-update">
                <button type="button" className="k42-bell-row k42-bell-notice" disabled={busy !== null} onClick={() => void markRead(notice, true)}>
                  <span className="k42-bell-unread" aria-hidden="true" />
                  <span className="k42-bell-system" aria-hidden="true"><ShieldAlert size={16} /></span>
                  <span className="k42-bell-text">
                    <span className="k42-bell-sentence"><strong>{notice.actorName}</strong> {moderationAction(notice)} <strong>{notice.agentName}</strong>: {notice.reason}</span>
                    <small>{notice.projectTitle}</small>
                  </span>
                  <time className="k42-bell-age" dateTime={new Date(notice.createdAt).toISOString()}>{shortAge(notice.createdAt, now)}</time>
                </button>
                <button type="button" className="k42-bell-dismiss" aria-label={`Clear ${notice.reason}`} title="Clear" disabled={busy !== null} onClick={() => void markRead(notice, false)}><X size={14} aria-hidden="true" /></button>
              </li>)}</ul>}
                {notices.next && <button type="button" className="k42-bell-quiet" disabled={busy !== null} onClick={() => void moreNotices()}>More updates</button>}</>}
      </div>
      {shown === 'needs-you' && <div className="k42-bell-footer"><NavLink to={{ view: 'needs-you' }} go={open}>View all requests</NavLink></div>}
    </section>
  </>;
}
