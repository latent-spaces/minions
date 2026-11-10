import { useRealtimeTick } from './realtime';
import { OutputsController } from './OutputsController';
import { UsageAnalytics } from './UsageAnalytics';
import { WebPresence } from './WebPresence';
import { sharedLink } from './shared-link';
import { AgentRequestsPopup } from './ui/AgentRequestsPopup';
import { privateProjects } from './api';
import { LifecycleFeedbackProvider } from './ui/LifecycleFeedback';
import { FeedbackDialog } from './ui/FeedbackDialog';
import { feedbackRequest } from './feedback-api';
import type { FeedbackPage } from '@mlswarm/contracts';
import { projectShortcuts } from './ui/project-shortcuts';
import { useShellFocus } from './ui/use-shell-focus';
import { NeedsYou, useOpenRequests } from './ui/NeedsYou';
import { ProjectControlFeedback, useProjectControls } from './ui/ProjectControls';
import { ProjectStatusPanel } from './ui/ProjectStatusPanel';
import { JobLimitsBar } from './ui/JobLimitsBar';
import { ProjectSetup } from './ProjectSetup';
import { Button } from './ui/Button';
import { CloseButton } from './ui/CloseButton';
import { OwnerConnectionApproval } from './ui/OwnerConnectionApproval';
import { personalProjectStatus, workspaceProjectStatus } from './ui/personal-project-status';
import { InvitedSignIn, type AccessRefusal } from './ui/InvitedSignIn';
import { ComingSoon } from './ui/ComingSoon';
import { SessionLoading } from './ui/SessionLoading';
import { ProductOverview } from './ui/ProductOverview';
import { WorkspaceNavigation, type ProjectMenu, type WorkspaceNavItem } from './ui/WorkspaceNavigation';
import { COMPACT_SHELL } from './ui/shell-breakpoint';
import { useMenuCollapsed } from './ui/menu-collapse';
import { ListTodo, Folder, Settings, Menu, Users, Activity, FileText, LogOut, House, MessageSquare } from 'lucide-react';
import { TopBar } from './ui/TopBar';
import { NotificationsBell } from './ui/NotificationsBell';
import { sidebarAgentRoute, menuMode, searchScope, searchPlaceholder, searchTarget } from './ui/shell-nav';
import { useMediaQuery } from './useMediaQuery';
// The project, agent connection setup, and read-only agents/conversations.
// Data refreshes every 30 s while the tab is visible.
import type { SessionUser } from './session-identity';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { session, read, community, projects, ProjectScope, ApiError, signIn, signOutNow, type AgentRow, type Overview } from './api';

import { MyProjects } from './MyProjects';
import { YourAgent } from './ui/YourAgent';
import { WaitingAddAgent, WaitingRoomCallout } from './ui/AddAgentPrompt';
import { PathHeading } from './ui/PathHeading';
import { notify } from './ui/Toast';
import { ProjectActivity } from './ProjectActivity';
import { ProjectTasks, type TaskAgent } from './ui/ProjectTasks';
import { tasksApi } from './tasks-api';
import { teamsApi } from './teams-api';
import { ProjectTeams } from './ui/ProjectTeams';
import { nativeTasksEnabled, nativeTeamsEnabled } from '@mlswarm/contracts';
import './ui/project-home.css';
import { canManageMerging } from './merging-access';
import { ControlCenter } from './ControlCenter';
import { MyWorkerControls } from './ui/MyWorkerControls';
import { useLeaveProject, LeaveProjectFeedback } from './LeaveProject';
import { Agents } from './Agents';
import { Conversations } from './Conversations';
import { MyComputers } from './MyComputers';
import { SidebarFooter } from './ui/SidebarFooter';
import { AccountMenu } from './ui/AccountMenu';
import { BrandLogo } from './ui/BrandLogo';
import { AddAgentNudge } from './ui/ProjectCheatSheet';
import { ProjectStartAnnouncement } from './ProjectStartAnnouncement';
import type { ProjectEntry, ProjectPage, Workspace } from './project-api';
import { formatRoute, mayLeaveProject, ownerApprovalRequest, parseRoute, projectRoute, validProjectId, type GlobalView, type Route, type Section } from './route';
import { NavLink, time, usePages } from './shared';
import { useAllPages } from './use-all-pages';
import { refreshOnReturn } from './refresh-on-return';
import { ProjectHeader, type HeaderMenuItem } from './ui/ProjectHeader';
import { useProjectUsage } from './ui/ProjectUsage';
import { CommunityDirectory } from './ui/CommunityDirectory';
import { ProjectHomePreparation } from './ui/ProjectHomePreparation';
import { waitingTitle, workerAgentStatus } from './ui/agent-running-state';
import { MyWorkersContext } from './ui/MyWorkerControls';
import type { CommunityAccount } from './community-api';
import { statusTone, toneClass } from './ui/tag-tone';

const REFRESH_MS = 30_000;
const STALE_MS = 90_000;

function workspaceEntry(workspace: Workspace): ProjectEntry {
  return { id: workspace.id, name: workspace.definition.title, summary: workspace.definition.goal,
    execution: workspace.execution, archived: workspace.archived, starred: workspace.starred, archiveRevision: workspace.archiveRevision, role: workspace.role as ProjectEntry['role'], state: workspace.state,
    listed: workspace.listed, participantCount: workspace.participantCount, coverImage: workspace.coverImage,
    minContributors: workspace.setup?.minContributors, startDeadline: workspace.setup?.startDeadline, private: !!workspace.privacy };
}
export function App() {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [accessTick, setAccessTick] = useState(0);
  const [signingIn, setSigningIn] = useState(false);
  const signInPending = useRef(false);
  // Announce "Signed in." only once the invitation check passes, never for a refused account.
  const announceSignIn = useRef(false);
  // Computer-approval links are read from the address before the workspace opens.
  const [entrySearch, setEntrySearch] = useState(() => window.location.search);
  useEffect(() => {
    const restore = () => setEntrySearch(window.location.search);
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  useEffect(() => session.onTokenChanged(value => {
    // A new GitHub sign-in is shown once the service has confirmed its emails (enterWorkspace).
    if (value && signInPending.current) return;
    setUser(value); setEntrySearch(window.location.search);
    // Reauthentication can keep the same SessionUser object. Recheck admission even then.
    setAccessTick(tick => tick + 1);
  }), []);

  const enterWorkspace = async (options: { chooseAccount?: boolean } = {}) => {
    if (signInPending.current || user === undefined) return;
    signInPending.current = true;
    setSigningIn(true);
    try {
      await signIn(options);
      setUser(session.currentUser()); setEntrySearch(window.location.search); setAccessTick(tick => tick + 1);
      announceSignIn.current = true;
    } catch (error) {
      console.warn('Sign-in was not completed.', error);
      notify(error instanceof ApiError ? error.message : 'Could not sign in. Try again.', 'error');
    } finally {
      signInPending.current = false;
      setSigningIn(false);
    }
  };

  // Only an invited account gets past the invited sign-in screen; the service refuses others with 401.
  const [access, setAccess] = useState<{ uid: string; refused: AccessRefusal | null; person?: CommunityAccount['person']; account?: CommunityAccount } | null>(null);
  // Coming soon stays the front page; its Sign in opens the invited sign-in screen.
  const [signInOpen, setSignInOpen] = useState(false);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    community<CommunityAccount>(user, '/me').then(result => {
      if (cancelled) return;
      setAccess({ uid: user.uid, refused: null, person: result.person, account: result });
      if (announceSignIn.current) { announceSignIn.current = false; notify('Signed in.'); }
    }, (error: Error) => {
      if (cancelled) return;
      announceSignIn.current = false;
      setAccess({ uid: user.uid, refused: error instanceof ApiError && error.status === 401 ? 'not-invited' : 'check-failed' });
    });
    return () => { cancelled = true; };
  }, [user, accessTick]);
  const checked = user && access?.uid === user.uid ? access : null;
  const render = () => {
    const ownerRequest = ownerApprovalRequest(entrySearch);
    if (ownerRequest) return <main><OwnerConnectionApproval key={`${user?.uid ?? 'guest'}:${ownerRequest}`} user={user} requestId={ownerRequest} onSignIn={() => void enterWorkspace()} signingIn={signingIn} /></main>;

    // Unknown authentication/admission is a loading state, not a signed-out or invited entry screen.
    if (user === undefined || user && !checked) return <SessionLoading />;
    if (!user && !signInOpen && !signingIn) return <ComingSoon onSignIn={() => setSignInOpen(true)} />;
    if (!user || !checked || checked.refused !== null) return <InvitedSignIn onSignIn={() => void enterWorkspace()}
      onChooseAccount={() => void enterWorkspace({ chooseAccount: true })} onSignOut={() => { setSignInOpen(false); void signOutNow(); }}
      onBack={user ? undefined : () => setSignInOpen(false)}
      onRetry={() => { setAccess(null); setAccessTick(value => value + 1); }} pending={signingIn}
      checking={false} signedInEmail={user?.email ?? undefined} refused={checked?.refused ?? undefined} />;
    const account = checked.account;
    if (!account) return <SessionLoading />;
    return <Viewer key={`${user.uid}:${account.person.id}`} user={user} account={account} />;
  };
  return user && checked?.person ? <WebPresence key={`${user.uid}:${checked.person.id}`} user={user} profileId={checked.person.id}>{render()}</WebPresence> : render();
}

const SHORTCUTS = 5;
const SECTION_NAMES: Record<Section, string> = { overview: 'Activity', outputs: 'Outputs', usage: 'Usage', tasks: 'Tasks', teams: 'Teams', agents: 'Agents', conversations: 'Conversations', 'control-center': 'Control center', 'needs-you': 'Needs you' };
// Needs you and My computers are not in the menu: the notifications bell and the account menu reach them.
const GLOBAL_NAMES: Record<GlobalView, string> = { projects: 'My projects', computers: 'My computers', create: 'Create project', 'needs-you': 'Needs you' };
/** Project navigation and own-agent shortcuts; web creation is hidden (OPE-230). */
type ProjectFacts = { projectId: string; connect: (() => void) | null; openAgent?: (id: string) => void; myAgents?: { provider?: string; id: string; name: string; status: string; detail: string; waiting?: boolean; queued?: boolean }[]; cheatSheet?: { title: string; started: boolean } | null };
const executionLabel = (p: ProjectEntry) => personalProjectStatus({ ...p, kind: 'project', proposalStatus: null }).label;

export function Viewer({ user, account }: { user: SessionUser; account: CommunityAccount }) {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.search));
  const [directory, setDirectory] = useState<ProjectPage | null>(null);
  const [selected, setSelected] = useState<ProjectEntry | null>(null);
  // `removed`: the project was open and then refused, so membership was removed or the project deleted.
  const [unavailable, setUnavailable] = useState<{ projectId: string; error: Error; removed: boolean } | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [directoryTick, setDirectoryTick] = useState(0);
  // The overview is manually opened and never reads or writes onboarding progress.
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const requestFeedback = useMemo(() => feedbackRequest(user), [user]);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const finishOverview = useCallback(() => setOverviewOpen(false), []);
  // A tab loads when it opens, even one opened in the background (e.g. by an agent checking the page); it stops
  // refreshing once it is hidden and carries on when shown again.
  const [visible, setVisible] = useState(true);
  const refresh = useCallback(() => setTick(t => t + 1), []);
  const refreshAll = useCallback(() => { setTick(t => t + 1); setDirectoryTick(t => t + 1); }, []);
  const communityRequest = useCallback(<T,>(path: string, body?: object) => community<T>(user, path, body), [user]);
  // Display name for the account row; refreshed after a profile save (refreshAll bumps directoryTick).
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [profileIdentity, setProfileIdentity] = useState<import('./community-api').MyProfileData | null>(null);
  useEffect(() => {
    let cancelled = false;
    communityRequest<import('./community-api').MyProfileData>('/my-profile').then(profile => { if (!cancelled) { setDisplayName(profile.name); setProfileIdentity(profile); } }, () => {});
    return () => { cancelled = true; };
  }, [communityRequest, directoryTick]);
  const compact = useMediaQuery(COMPACT_SHELL);
  // The desktop menu may collapse to an icon rail; compact screens keep the drawer.
  const [menuCollapsed, setMenuCollapsed] = useMenuCollapsed();
  const rail = !compact && menuCollapsed;
  const [navigationOpen, setNavigationOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLElement>(null);
  useShellFocus(compact, content);
  // When the overview closes, return focus to the preserved workspace destination.
  const overviewWasOpen = useRef(overviewOpen);
  useEffect(() => {
    if (overviewWasOpen.current && !overviewOpen) content.current?.focus();
    overviewWasOpen.current = overviewOpen;
  }, [overviewOpen]);
  const failureHeading = useRef<HTMLHeadingElement>(null);
  // Where focus goes after the location or the drawer changes: the menu button when the drawer is dismissed, the
  // content after choosing a destination in the drawer, and the content when the control that was used disappeared.
  const focusNext = useRef<'menu' | 'content' | 'lost' | null>(null);
  // The open agent's name, for the breadcrumb and the page title; it belongs to the project and agent that reported it.
  const [agentName, setAgentName] = useState<{ projectId: string; id: string; name: string } | null>(null);
  const reportAgent = useCallback((projectId: string, id: string, name: string) => setAgentName({ projectId, id, name }), []);
  // Facts belong to the project that reported them.
  const [facts, setFacts] = useState<ProjectFacts | null>(null);
  const [searchText, setSearchText] = useState('');
  // The open project stays mounted (hidden) on global pages; only opening another project replaces it.
  const current = useRef({ route, selected, navigationOpen });
  current.current = { route, selected, navigationOpen };
  const leaves = (next: Route) => next.view === 'project' && current.current.selected !== null && next.projectId !== current.current.selected.id
    || current.current.route.view === 'create' && formatRoute(next) !== formatRoute(current.current.route);
  const closeAfterDestination = () => {
    const active = document.activeElement;
    focusNext.current = current.current.navigationOpen ? 'content' : active && active !== document.body ? 'lost' : null;
    setNavigationOpen(false);
  };
  // Each entry records its position, so a declined Back or Forward can return to the entry it left.
  const position = useRef(0);
  const navigate = useCallback((next: Route, replace = false) => {
    if (leaves(next) && !mayLeaveProject()) return;
    closeAfterDestination(); setRoute(next);
    // Choosing a refused project again asks the service again.
    if (next.view === 'project') setUnavailable(u => u?.projectId === next.projectId ? null : u);
    const search = formatRoute(next);
    // Choosing the current location again replaces it, as a link to the same URL does.
    if (replace || search === window.location.search) window.history.replaceState({ at: position.current }, '', search);
    else window.history.pushState({ at: ++position.current }, '', search);
  }, []);
  useEffect(() => {
    position.current = typeof window.history.state?.at === 'number' ? window.history.state.at : 0;
    window.history.replaceState({ at: position.current }, '', formatRoute(current.current.route));
    const restore = (event: PopStateEvent) => {
      const next = parseRoute(window.location.search);
      const at: unknown = event.state?.at;
      if (leaves(next) && !mayLeaveProject()) {
        // go(0) would reload and discard the retry; an entry without a usable position is answered with a new one.
        if (typeof at === 'number' && at !== position.current) window.history.go(position.current - at);
        else window.history.pushState({ at: ++position.current }, '', formatRoute(current.current.route));
        return;
      }
      if (typeof at === 'number') position.current = at;
      closeAfterDestination(); setRoute(next);
      if (next.view === 'project') setUnavailable(u => u?.projectId === next.projectId ? null : u);
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  const select = useCallback((entry: ProjectEntry) => setSelected(entry), []);
  const denied = useCallback((projectId: string, error: Error) => {
    setUnavailable({ projectId, error, removed: true });
    setSelected(s => s?.id === projectId ? null : s);
    setDirectoryTick(t => t + 1);
  }, []);
  // Refreshing asks again about a refused project too.
  const reload = useCallback(() => { setUnavailable(null); refreshAll(); }, [refreshAll]);
  // The focused Try again disappears with the failure, so the content keeps focus.
  const retry = () => { content.current?.focus({ preventScroll: true }); reload(); };
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(refreshAll, REFRESH_MS);
    const stop = refreshOnReturn(refreshAll);
    return () => { window.clearInterval(timer); stop(); };
  }, [visible, refreshAll]);
  // The bounded shortcut endpoint prioritizes saved stars independently of directory pagination.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    projects<ProjectPage>(user, '/shortcuts').then(value => {
      if (cancelled) return;
      setDirectory(value); setListError(null);
      setSelected(previous => previous ? value.projects.find(p => p.id === previous.id) ?? previous : previous);
    }, e => { if (!cancelled) { console.warn('Could not refresh project shortcuts.', e); setListError(e.message); } });
    return () => { cancelled = true; };
  }, [user, directoryTick, visible]);
  // A link can name any project: one outside the loaded sidebar page is read directly, and the
  // service answers 404 alike for a missing project and one this account cannot open.
  const wanted = route.view === 'project' ? route.projectId : null;
  const refused = unavailable?.projectId === wanted;
  useEffect(() => {
    if (wanted === null || selected?.id === wanted || refused) return;
    const listed = directory?.projects.find(p => p.id === wanted);
    if (listed) { select(listed); return; }
    if (!validProjectId(wanted)) { setUnavailable({ projectId: wanted, error: new ApiError(400, 'This link does not name a project.'), removed: false }); return; }
    let cancelled = false;
    projects<Workspace>(user, `/${wanted}`).then(w => {
      if (!cancelled) select(workspaceEntry(w));
    }, (e: Error) => { if (!cancelled) setUnavailable({ projectId: wanted, error: e, removed: false }); });
    return () => { cancelled = true; };
  }, [user, wanted, selected?.id, refused, directory, select]);
  useEffect(() => {
    if (!selected || !directory || directory.projects.some(project => project.id === selected.id)) return;
    let cancelled = false;
    projects<Workspace>(user, `/${selected.id}`).then(workspace => {
      if (!cancelled) setSelected(previous => previous?.id === workspace.id ? workspaceEntry(workspace) : previous);
    }, () => {});
    return () => { cancelled = true; };
  }, [user, directory, selected?.id]);
  useEffect(() => { if (!compact) setNavigationOpen(false); }, [compact]);
  // A modal <dialog> makes the rest of the page inert, focuses its first control, and closes on Escape or the
  // platform's back gesture; this effect only mirrors the open state.
  useEffect(() => {
    const dialog = drawer.current;
    if (navigationOpen && dialog && !dialog.open) dialog.showModal();
    else if (!navigationOpen && dialog?.open) dialog.close();
  }, [navigationOpen, compact]);
  useEffect(() => {
    const next = focusNext.current;
    focusNext.current = null;
    const active = document.activeElement as HTMLElement | null;
    const lost = !active || active === document.body || active.checkVisibility?.() === false;
    if (next === 'menu') menuButton.current?.focus({ preventScroll: true });
    else if (next === 'content' || next === 'lost' && lost) content.current?.focus({ preventScroll: true });
  }, [route, navigationOpen]);
  function dismiss() { focusNext.current = 'menu'; setNavigationOpen(false); }
  const projectShown = route.view === 'project' && selected?.id === route.projectId;
  const failure = route.view === 'project' && !projectShown && unavailable?.projectId === route.projectId ? unavailable : null;
  useEffect(() => { if (failure) failureHeading.current?.focus(); }, [failure]);
  const section = route.view === 'project' ? route.section : 'overview';
  const agent = route.view === 'project' ? route.agent : null;
  const agentSearch = route.view === 'project' ? route.q : null;
  const agentLabel = agent && agentName?.projectId === selected?.id && agentName?.id === agent ? agentName.name : 'Agent';
  const go = (next: Route, replace = false) => navigate(next, replace);
  const chooseSection = useCallback((next: Section) => {
    const { route: now } = current.current;
    if (now.view === 'project') navigate({ ...now, section: next, thread: next === 'conversations' ? now.thread : null, agent: null, q: null });
  }, [navigate]);
  const known = selected && directory && !directory.projects.some(p => p.id === selected.id) ? [selected, ...directory.projects] : directory?.projects ?? [];
  const shortcuts = projectShortcuts(known, selected, SHORTCUTS);
  const archiveChanged = (id: string, archived: boolean) => {
    setSelected(previous => previous?.id === id ? { ...previous, archived } : previous);
    setDirectory(previous => previous && { ...previous, projects: previous.projects.filter(project => project.id !== id) });
    refreshAll();
  };
  const location = route.view === 'project' ? `${projectShown ? selected!.name : 'Project'} / ${SECTION_NAMES[section]}${agent ? ` / ${agentLabel}` : ''}` : GLOBAL_NAMES[route.view];
  useEffect(() => {
    document.title = `${location} · MyLittleSwarm`;
    return () => { document.title = 'MyLittleSwarm'; };
  }, [location]);
  const failed = failure && failure.error instanceof ApiError && [400, 401, 403, 404].includes(failure.error.status) ? failure : null;
  const openFeedback = () => { setFeedbackOpen(true); setNavigationOpen(false); };
  const openOverview = () => { if (mayLeaveProject()) setOverviewOpen(true); };
  const signOutFromMenu = () => { if (mayLeaveProject()) void signOutNow(); };
  // The account lives in the top bar (shell polish 2026-10-18, section 12).
  // Projects first in the menu: the global menu, or inside a project that project's sections and Switch project.
  const openProject = menuMode(route, projectShown ? selected!.id : null) === 'project' ? selected! : null;
  const openFacts = openProject && facts?.projectId === openProject.id ? facts : null;
  const projectsLink: WorkspaceNavItem = { id:'projects', label:GLOBAL_NAMES.projects, icon:<Folder size={18} />, href:formatRoute({ view:'projects' }), current:route.view === 'projects' || route.view === 'create', onNavigate:() => go({ view:'projects' }) };
  const accountMenu = <AccountMenu personId={profileIdentity?.id} photo={profileIdentity?.photo} name={displayName} go={go} onOverview={openOverview} signOut={signOutFromMenu} />;
  const shortcut = (p: ProjectEntry) => ({ id:p.id, name:p.name, href:formatRoute(projectRoute(p.id)), onNavigate:() => go(projectRoute(p.id)), status:executionLabel(p), private:p.private });
  // New project opens project creation directly (owner, 19 October 2026); agents are added through local MCP.
  const projectMenu: ProjectMenu | null = openProject && { id:openProject.id, name:openProject.name, status:executionLabel(openProject), private:openProject.private,
    back: { id:'all-projects', label:'All projects', href:formatRoute({ view:'projects' }), onNavigate:() => go({ view:'projects' }) },
    // Project sections live in header tabs; the menu keeps identity and own-agent shortcuts.
    connect: openFacts?.connect ?? null,
    // Cheat sheet in the menu opens the project's prompts in a popup.
    cheatSheet: openFacts?.cheatSheet ?? null,
    // Agent activation opens outstanding requests in place; queued starts retain their setup destination.
    myAgents: (openFacts?.myAgents ?? []).map(a => { const to = sidebarAgentRoute(openProject.id, a); return { ...a, ownerId: account.person.id, href: formatRoute(to), onNavigate: () => { if (!a.queued && openFacts?.openAgent) { setNavigationOpen(false); openFacts.openAgent(a.id); } else go(to); } }; }) };
  // The search belongs to the open project; the box resets when that scope changes.
  const scope = searchScope(openProject?.id ?? null);
  useEffect(() => setSearchText(''), [scope]);
  const navigation = <>
    {compact && <CloseButton label="Close navigation" onClick={dismiss} />}
    <WorkspaceNavigation collapsed={rail} onCollapsedChange={compact ? undefined : setMenuCollapsed}
      brand={compact ? undefined : <span className="k42-brand-lockup"><NavLink to={{ view:'projects' }} go={go} className="wordmark"><BrandLogo /></NavLink><span className="k42-tagline">Build together at scale</span></span>}
      footer={compact ? undefined : <SidebarFooter collapsed={rail} onFeedback={openFeedback} />}
      globals={[]} projectsLink={projectsLink} onCreate={() => go({ view:'create' })} project={projectMenu}
      projects={shortcuts.map(shortcut)}
      projectStatus={listError || !directory ? <>
        {listError && <Button onClick={refreshAll}>Try again</Button>}
        {!directory && !listError && <p className="muted" role="status">Loading projects…</p>}
      </> : undefined}
    />
  </>;
  if (overviewOpen) return <ProductOverview onDone={finishOverview} />;
  const feedbackPage: FeedbackPage = route.view === 'project' ? 'Project' : route.view === 'projects' ? 'My projects' : route.view === 'needs-you' ? 'Needs you' : 'Other';
  return <LifecycleFeedbackProvider request={requestFeedback} profileId={account.person.id} accountId={user.uid}><div className="page workspace">
    {feedbackOpen && <FeedbackDialog key={`${user.uid}:${account.person.id}`} request={requestFeedback} profileId={account.person.id} accountId={user.uid} page={feedbackPage} onClose={() => { setFeedbackOpen(false); requestAnimationFrame(() => content.current?.focus({ preventScroll: true })); }} />}
    <a className="skip-link" href="#content" onClick={e => { e.preventDefault(); content.current?.focus(); }}>Skip to content</a>
    <div className={`workspace-layout${rail ? ' is-menu-collapsed' : ''}`}>
      {compact
        // A click on the backdrop reaches the dialog itself; the body fills the panel, so clicks inside never do.
        ? <dialog ref={drawer} id="workspace-navigation" className="project-sidebar drawer" aria-label="Navigation"
          onClose={() => { if (current.current.navigationOpen) dismiss(); }} onClick={e => { if (e.target === e.currentTarget) dismiss(); }}>
          <div className="drawer-body">{navigation}</div>
        </dialog>
        : <aside className="project-sidebar">{navigation}</aside>}
      <div className="workspace-column">
        <TopBar compact={compact} search={searchText} onSearch={setSearchText} placeholder={openProject ? searchPlaceholder(openProject.name) : null}
          onSubmit={() => { const next = searchTarget(searchText, openProject?.id ?? null); if (next) go(next); }}
          notifications={<NotificationsBell user={user} active={visible} go={go} />}
          leading={<><Button ref={menuButton} className="menu-button" aria-expanded={navigationOpen} aria-controls="workspace-navigation" onClick={() => setNavigationOpen(true)} aria-label="Open navigation"><Menu size={20} /></Button>
            <NavLink to={{ view:'projects' }} go={go} className="wordmark"><BrandLogo /></NavLink></>}
          actions={<>
            {/* Creating starts from the + beside Your projects, so the top bar has no New project button (Noa, 18 October 2026). */}
            {accountMenu}
          </>} />
        <main id="content" ref={content} tabIndex={-1} className="workspace-content">
          <div hidden={!['projects', 'create'].includes(route.view)}><MyProjects user={user} view={route.view !== 'project' ? route.projectList ?? 'current' : 'current'} onArchiveChange={archiveChanged} active={route.view === 'projects' && visible} refreshKey={directoryTick} go={go} retry={refreshAll} /></div>
          {route.view === 'computers' && <MyComputers key={`${user.uid}:${account.person.id}`} user={user} active={visible} refreshKey={directoryTick} go={go} retry={refreshAll} />}
          {route.view === 'create' && <ProjectSetup key={user.uid} user={user} go={go} refresh={refreshAll} />}
          {route.view === 'needs-you' && <NeedsYou key={user.uid} user={user} go={go} />}
          {selected && <div hidden={!projectShown}><ProjectScope.Provider value={selected.id}><ProjectContent key={selected.id} suppliedProfileId={account.person.id} user={user} projectId={selected.id} section={section} chooseSection={chooseSection} agent={agent} search={agentSearch} agentFilter={route.view === 'project' ? route.agentFilter ?? 'mine' : 'mine'} onAgent={reportAgent} go={go} thread={route.view === 'project' ? route.thread : null} messageId={route.view === 'project' ? route.message : undefined} controlSection={route.view === 'project' ? route.controlSection : undefined} tick={tick} refresh={refresh} refreshAll={refreshAll} active={projectShown && visible} onDenied={denied} onFacts={setFacts} /></ProjectScope.Provider></div>}
          {route.view === 'project' && !projectShown && !failure && <p className="muted" role="status">Loading project…</p>}
          {failure && <section className="project-readme" aria-labelledby="project-unavailable">
            <PathHeading id="project-unavailable" headingRef={failureHeading} tabIndex={-1} go={go} title={failed ? failure.removed ? 'You no longer have access to this project' : 'Project not available' : 'Could not open this project'} />
            <p role="alert">{failure.error.message}</p>
            {failed && <p className="muted">{failure.removed ? 'Your membership may have been removed, or the project was deleted.' : 'The project may not exist, or this account is not one of its members.'} Ask the project owner for access.</p>}
            <div className="actions"><Button onClick={retry}>Try again</Button><NavLink to={{ view: 'projects' }} go={go}>My projects</NavLink></div>
          </section>}
        </main>
      </div>
    </div>
  </div></LifecycleFeedbackProvider>;
}

// Task 11: the project's tabs, shared by the header's tab row and the menu.
type ProjectTab = { id: Section; label: string; icon: typeof Activity };
const PROJECT_TABS: ProjectTab[] = [{ id:'overview', label:'Home', icon:House }, { id:'outputs', label:'Outputs', icon:FileText }, { id:'tasks', label:'Tasks', icon:ListTodo }, { id:'teams', label:'Teams', icon:Users }, { id:'conversations', label:'Conversations', icon:MessageSquare }, { id:'usage', label:'Usage', icon:Activity },
  { id:'control-center', label:'Control center', icon:Settings }];
function tabRoute(projectId: string, tab: ProjectTab): Route {
  return projectRoute(projectId, tab.id);
}
// Sharing a link preserves the server's existing admission and project-access rules.
async function shareProjectLink(projectId: string) {
  let link: string;
  try { link = await sharedLink(`/viewer/${formatRoute(projectRoute(projectId))}`); }
  catch { notify('Could not create a project link. Try again.'); return; }
  try { await navigator.clipboard.writeText(link); notify('Project link copied.'); }
  catch { window.prompt('Copy the project link:', link); }
}
// Stable empty lists, so an unloaded first page does not change the directory on every render.
const NO_AGENTS: AgentRow[] = [], NO_PEOPLE: { id: string; name: string | null }[] = [];
const membersPath = () => '/members';
// Task labels need no live status: the labels view skips each agent's presence, run, session and usage reads.
const allAgentsPath = (cursor: string | null) => `/agents?view=labels${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
const allMembersPath = (cursor: string | null) => `/members${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
const agentRowsPath = () => '/agents';
function ProjectContent({ suppliedProfileId, user, projectId, section, chooseSection, agent, search, agentFilter, onAgent, go, thread, messageId, controlSection, tick, refresh, refreshAll, active, onDenied, onFacts }: { suppliedProfileId: string; user: SessionUser; projectId: string; section: Section; chooseSection: (section: Section) => void; agent: string | null; search: string | null; agentFilter: 'mine' | 'all'; onAgent: (projectId: string, id: string, name: string) => void; go: (to: Route, replace?: boolean) => void; thread: string | null; messageId?: string; controlSection?: Extract<Route, { view: 'project' }>['controlSection']; tick: number; refresh: () => void; refreshAll: () => void; active: boolean; onDenied: (projectId: string, error: Error) => void; onFacts: (facts: ProjectFacts) => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const leave = useLeaveProject(user, () => go({ view: 'projects' }));
  const controls = useProjectControls(user, workspace, refreshAll, active, () => go({ view: 'projects' }));
  const [controlsDisabled, setControlsDisabled] = useState(false);

  const [clock, setClock] = useState(Date.now());
  const visible = active;
  // A refusal of a project that was open means membership was removed or the project deleted.
  const failed = useCallback((e: Error) => {
    if (e instanceof ApiError && [401, 403, 404].includes(e.status)) { setOverview(null); setWorkspace(null); onDenied(projectId, e); }
    setError(e.message);
  }, [projectId, onDenied]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    Promise.all([read<Overview>(user, '/overview', projectId), projects<Workspace>(user, `/${projectId}`)]).then(([o, w]) => {
      if (cancelled) return;
      setOverview(o); setWorkspace(w);
      setError(null); setLoadedAt(Date.now());
    }, (e: Error) => !cancelled && failed(e));
    return () => { cancelled = true; };
  }, [user, projectId, tick, visible, failed]);

  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => {
      setClock(Date.now());
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [visible]);

  const observationAge = overview && loadedAt !== null
    ? Math.max(0, overview.serverTime - overview.generatedAt) + Math.max(0, clock - loadedAt) : 0;
  const stale = loadedAt !== null && observationAge > STALE_MS;

  const project = workspace?.project;
  // Before start, a project's Home is its waiting room. In a private project only the owner opens the other tabs then.
  const waiting = !!workspace && !project?.started && workspace.execution !== 'closed';
  const restricted = waiting && !!workspace!.privacy && workspace!.role !== 'owner';
  const currentSection = restricted ? 'overview' : section;
  const projectTabsRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (currentSection !== 'control-center' || !canManageMerging(workspace?.role)) return;
    const reveal = () => {
      const nav = projectTabsRef.current, selected = nav?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!nav || !selected) return;
      const strip = nav.getBoundingClientRect(), item = selected.getBoundingClientRect();
      if (item.left < strip.left || item.right > strip.right) nav.scrollLeft += item.left - strip.left - (strip.width - item.width) / 2;
    };
    reveal(); window.addEventListener('resize', reveal);
    return () => window.removeEventListener('resize', reveal);
  }, [currentSection, workspace?.role]);
  useEffect(() => { if (restricted && section !== 'overview') chooseSection('overview'); }, [restricted, section, chooseSection]);
  const status = workspace ? workspaceProjectStatus(workspace).label : 'Loading project…';
  // The people chat stays docked beside every section.
  const communityAgents = currentSection === 'agents' && agentFilter === 'all';
  const allAgents = communityAgents && !agent;
  const members = usePages<{ id: string; owner?: boolean; name: string | null; photo?: import('./profile-photo-api').PublicPhoto | null }>(user, membersPath, tick, visible && !!workspace);
  const crowd = members.page?.items ?? [];
  const agentStatusTick = useRealtimeTick(user, projectId, 'agents', visible && !!project);
  const agentNeedsTick = useRealtimeTick(user, projectId, 'needs-you', visible && !!project);
  const teamsTick = useRealtimeTick(user, projectId, 'teams', visible && currentSection === 'teams' && !!project);
  const agentTick = agentStatusTick + agentNeedsTick;
  const agentRows = usePages<AgentRow>(user, agentRowsPath, tick + agentTick, visible && !!project);
  // Task assignees, contributors and comment authors can be anyone in the project, not only the first directory page.
  const tasksShown = visible && currentSection === 'tasks' && !!workspace;
  const taskAgents = useAllPages<TaskAgent>(user, allAgentsPath, 'agents', agentRows.page?.items ?? NO_AGENTS, tick, tasksShown && !!project, REFRESH_MS);
  const taskPeople = useAllPages(user, allMembersPath, 'members', members.page?.items ?? NO_PEOPLE, tick, tasksShown, REFRESH_MS);
  // One read labels up to 60 shown actors the paced walks have not reached; it counts once against the viewer budget.
  const taskLabels = useMemo(() => ({
    agents: async (ids: string[]) => (await read<{ agents: TaskAgent[] }>(user, `/agents?view=labels&ids=${ids.map(encodeURIComponent).join(',')}`, projectId)).agents,
    members: async (ids: string[]) => (await read<{ members: typeof NO_PEOPLE }>(user, `/members?ids=${ids.map(encodeURIComponent).join(',')}`, projectId)).members,
  }), [user, projectId]);
  // Directory cursors belong to this surface. Paging never replaces the first-page
  // observations used by the project header or its contextual shortcuts.
  const directoryShown = visible && allAgents;
  const directoryPeople = usePages<{ id: string; owner?: boolean; name: string | null; photo?: import('./profile-photo-api').PublicPhoto | null }>(user,
    cursor => `/members${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, tick, directoryShown && !!workspace);
  const directoryBots = usePages<AgentRow>(user, cursor => {
    const params = new URLSearchParams();
    if (communityAgents && search) params.set('q', search);
    if (cursor) params.set('cursor', cursor);
    return `/agents${params.size ? `?${params}` : ''}`;
  }, tick + agentTick, directoryShown && !!project);
  const directoryMembers = directoryPeople.page?.items ?? [], directoryAgents = directoryBots.page?.items ?? [];
  const directoryPaging = {
    people: { first: directoryPeople.first, hasNext: !!directoryPeople.page?.next, onBack: directoryPeople.newer, onNext: directoryPeople.older, error: directoryPeople.error },
    agents: { first: directoryBots.first, hasNext: !!directoryBots.page?.next, onBack: directoryBots.newer, onNext: directoryBots.older, error: directoryBots.error },
  };
  const searchAgents = (query: string) => go(projectRoute(projectId, 'agents', null, query || null, 'all'), true);
  // Both entry paths supply the authenticated participant's immutable profile identity.
  const ownProfileId = suppliedProfileId;
  // One explicit visit observation after this signed-in person actually opens the project.
  // It is not a heartbeat, a model run, or evidence of active minutes.
  useEffect(() => {
    if (!visible || !workspace?.privacy || !ownProfileId) return;
    void privateProjects(user, ownProfileId, `/${projectId}/visit`, {}).catch(() => undefined);
  }, [user, projectId, ownProfileId, visible, !!workspace?.privacy]);
  const openRequests = useOpenRequests(user, projectId, visible);
  const [requestAgent, setRequestAgent] = useState<{ id: string; checking: boolean } | null>(null);
  useEffect(() => { if (!visible) setRequestAgent(null); }, [visible]);
  const agentNavigation = useRef(go); agentNavigation.current = go;
  const activateAgent = useCallback((id: string) => {
    if (openRequests.agentIds.includes(id) || !openRequests.ready || openRequests.error) setRequestAgent({ id, checking: !openRequests.ready || (!!openRequests.error && !openRequests.agentIds.includes(id)) });
    else agentNavigation.current(projectRoute(projectId, 'agents', id, null, 'all'));
  }, [openRequests.agentIds, openRequests.ready, openRequests.error, projectId]);
  useEffect(() => {
    if (requestAgent?.checking && openRequests.ready && !openRequests.error) {
      if (openRequests.agentIds.includes(requestAgent.id)) setRequestAgent({ ...requestAgent, checking: false });
      else { setRequestAgent(null); agentNavigation.current(projectRoute(projectId, 'agents', requestAgent.id, null, 'all')); }
    }
  }, [requestAgent, openRequests.ready, openRequests.error, openRequests.agentIds, projectId]);
  const teams = useMemo(() => teamsApi(user, projectId, ownProfileId ?? undefined, () => session.currentUid()), [user, projectId, ownProfileId]);
  const tasks = useMemo(() => tasksApi(user, projectId, ownProfileId ?? undefined, () => session.currentUid()), [user, projectId, ownProfileId]);
  // Own shortcuts come from the bounded private aggregate, not the first page
  // of everyone else's directory. Other participants cannot crowd them out.
  const myAgents = useMemo((): NonNullable<ProjectFacts['myAgents']> => [
    ...(controls.workers.data?.queued.map(start => ({ id: start.id, name: start.name, status: 'Waiting', detail: waitingTitle(start.waitingFor), queued: true })) ?? []),
    ...(controls.workers.data?.agents.map(row => {
      const { label: status, title } = workerAgentStatus(row, controls.workers.now);
      // A waiting agent says what it waits for, the same line a queued website agent shows.
      return { id: row.agentId, name: row.agentName, provider: row.run?.execution.provider ?? row.usage?.provider, personaChoice: row.personaChoice, status, detail: row.focus?.text || (status === 'Waiting' ? title : status), waiting: openRequests.agentIds.includes(row.agentId) };
    }) ?? [])], [controls.workers.data, controls.workers.now, openRequests.agentIds]);
  const myAgentsKey = myAgents.map(a => `${a.id}:${a.provider}:${a.status}:${a.detail}:${a.waiting}`).join(',');
  const cheatSheet = useMemo(() => workspace && workspace.execution !== 'closed' ? { title: workspace.definition.title, started: !!project?.started } : null, [workspace?.execution, workspace?.definition.title, project?.started]);
  useEffect(() => { onFacts({ projectId, connect: null, openAgent: activateAgent, myAgents, cheatSheet }); }, [onFacts, projectId, myAgentsKey, activateAgent, cheatSheet]);
  const owner = workspace?.role === 'owner';
  const isPrivate = !!workspace?.privacy;
  const analyticsRequest = useCallback(<T,>(path: string) => read<T>(user, path, projectId), [user, projectId]);
  const usage = useProjectUsage(user, projectId, visible && !!workspace, tick);
  // A public project's link can be copied and shared; it grants no role.
  const copyLink = workspace && workspace.execution !== 'closed' && !isPrivate ? () => void shareProjectLink(projectId) : null;
  const menu: HeaderMenuItem[] = [
    // Personal membership actions stay in the project menu.
    ...(isPrivate && !restricted && !owner && workspace?.role !== 'guest' ? [{ id:'leave', label:'Leave project', icon:<LogOut size={18} aria-hidden="true" />, onSelect:() => void leave.act(projectId) }] : []),
  ];
  // Detail pages and the sections without a tab keep their breadcrumb heading; the card's title is then an h2.
  const detail = !allAgents && (!!agent || !['overview', 'outputs', 'usage', 'tasks', 'teams', 'conversations', 'needs-you', 'control-center'].includes(currentSection));
  const tabs = <nav ref={projectTabsRef} className="k42-ph-tabs" aria-label="Project sections">
    {PROJECT_TABS.filter(tab => (tab.id !== 'conversations' || workspace?.role !== 'guest' || workspace.publicationOrigin !== 'owner_conversion') && (tab.id !== 'outputs' || workspace?.role !== 'guest') && (tab.id !== 'usage' || workspace?.role !== 'guest') && (tab.id !== 'control-center' || canManageMerging(workspace?.role)) && (tab.id !== 'tasks' || nativeTasksEnabled(workspace?.nativeTasks)) && (tab.id !== 'teams' || nativeTeamsEnabled(workspace?.nativeTeams))).map(tab => restricted && tab.id !== 'overview' ? <Button key={tab.id} disabled aria-disabled="true" title="Available when the project starts">{tab.label}</Button> : <NavLink key={tab.label} to={tabRoute(projectId, tab)} go={go}
      current={currentSection === tab.id && !detail}>{tab.label}</NavLink>)}
  </nav>;
  return (
    <MyWorkersContext.Provider value={controls.workers}>
    {requestAgent && <AgentRequestsPopup key={requestAgent.id} user={user} projectId={projectId} agentId={requestAgent.id} name={agentRows.page?.items.find(row => row.id === requestAgent.id && row.revokedAt === null)?.name ?? openRequests.requests.find(row => row.agentId === requestAgent.id)?.agentName ?? 'Agent'} requests={openRequests.requests.filter(row => row.agentId === requestAgent.id)} loading={!openRequests.ready} loadError={openRequests.error} retry={openRequests.retry} readOnly={workspace?.execution === 'closed'} go={go} onClose={() => setRequestAgent(null)} />}
    <div>
      <div className="k42-project-main k42-reveal">
        {/* The focused Try again disappears on success, so the viewer's content keeps focus. */}
        {error && <div role="alert"><p className="error">Could not load: {error}</p><Button onClick={() => { document.getElementById('content')?.focus({ preventScroll: true }); refresh(); }}>Try again</Button></div>}
        {!overview && !error && <p className="muted" role="status">Loading…</p>}
        {overview && <>
          {workspace && <ProjectHeader id={projectId} name={project?.name ?? workspace.definition.title} isPrivate={isPrivate} createdBy={members.first ? crowd.find(person => person.owner === true)?.name ?? null : null} statusPanel={<ProjectStatusPanel workspace={workspace} controls={controls} disabled={controlsDisabled} />}
            repositorySummary={overview.repositorySummary} usage={usage} repoUrl={project?.repoUrl}
            onCopyLink={copyLink}
            menu={menu}
            observed={<>{stale && <p className="warn observation-age">Out of date: last updated {time(overview.generatedAt)}</p>}</>}
            tabs={tabs} titleLevel={detail ? 2 : 1} />}
          {!workspace && <><div className="project-heading"><PathHeading title={project?.name ?? ''} parents={[{label:'My projects',to:{view:'projects'}}]} go={go} />
            <span className={`badge execution${toneClass(statusTone(status))}`}>{status}</span></div>{tabs}</>}
          <LeaveProjectFeedback controls={leave} />
          {workspace?.startAnnouncement && <ProjectStartAnnouncement key={`${user.uid}:${projectId}:${workspace.startAnnouncement.revision}`} user={user} profileId={suppliedProfileId} projectId={projectId} announcement={workspace.startAnnouncement} active={visible} onUpdated={refreshAll} />}
          {workspace && <ProjectControlFeedback controls={controls} disabled={controlsDisabled} />}
          {workspace && detail && !agent && <div className="project-heading">
            <PathHeading trail={false} title={SECTION_NAMES[currentSection]}
              parents={[{label:'My projects',to:{view:'projects'}}, {label:project?.name ?? workspace?.definition.title ?? '',to:projectRoute(projectId)},
                ...(agent ? [{label:SECTION_NAMES[currentSection],to:projectRoute(projectId,currentSection,null,search,agentFilter)}] : [])]} go={go} />
          </div>}

          {workspace && <div hidden={currentSection !== 'overview'} className="k42-overview">
            {waiting && workspace.role !== 'owner' && <WaitingRoomCallout />}
            {waiting && workspace.role !== 'guest' && <WaitingAddAgent projectName={project?.name ?? workspace.definition.title} waitingForOwner={workspace.role !== 'owner'} />}
            {!waiting && project && <ProjectActivity liveUrl={workspace.liveUrl ?? null} user={user} tick={tick} active={visible && currentSection === 'overview'} go={go} projectName={project.name ?? workspace.definition.title} canAddAgent={workspace.role !== 'guest'} readOnly={workspace.execution === 'closed'} pauseRequest={project.paused ? project.pauseRequest : undefined} agentRows={agentRows.page?.items ?? []} onOpenAgent={activateAgent} onCopyLink={copyLink} />}
            {workspace.execution !== 'closed' && workspace.role !== 'guest' && controls.workers.data && !myAgents.length && <AddAgentNudge key={projectId} projectId={projectId} title={workspace.definition.title} started={!!project?.started} />}
            {!project && <ProjectHomePreparation owner={owner} closed={workspace.execution === 'closed'} projectId={projectId} go={go} />}
          </div>}
          {workspace && workspace.role !== 'guest' && currentSection === 'outputs' && <OutputsController key={`${user.uid}:${projectId}`} user={user} profileId={suppliedProfileId} projectId={projectId} owner={owner} closed={workspace.execution === 'closed'} active={visible} title={workspace.definition.title} />}
          {workspace && workspace.role !== 'guest' && currentSection === 'usage' && visible && <UsageAnalytics scope={`${user.uid}:${projectId}`} request={analyticsRequest} />}
          {workspace && currentSection === 'needs-you' && visible && <NeedsYou key={`${user.uid}:${projectId}`} user={user} projectId={projectId} readOnly={workspace.execution === 'closed'} />}
          <div hidden={currentSection !== 'control-center'}>
            {workspace && <ControlCenter refreshKey={tick} category={controlSection} setControlsDisabled={setControlsDisabled} controls={controls} controlsDisabled={controlsDisabled} user={user} workspace={workspace} refresh={refreshAll} active={visible && currentSection === 'control-center'} go={go} />}
          </div>
          <div hidden={currentSection !== 'agents'}>
            {workspace && allAgents && <CommunityDirectory projectId={projectId} members={directoryMembers} agents={directoryAgents} loading={!!project && !directoryBots.page} now={clock} go={go} paging={directoryPaging} ownerFirst={directoryPeople.first} agentQuery={search ?? ''} onAgentQuery={searchAgents} />}
            {workspace && !agent && !allAgents && <nav className="k42-agent-filters" aria-label="Agent filter">
              <NavLink to={projectRoute(projectId,'agents')} go={go} current={agentFilter === 'mine'}>My agents</NavLink>
              <NavLink to={projectRoute(projectId,'agents',null,null,'all')} go={go} current={agentFilter === 'all'}>All agents</NavLink>
            </nav>}
            <div hidden={agent !== null || agentFilter !== 'mine'}>
              {workspace && <MyWorkerControls inline projectId={projectId} controls={controls.workers} disabled={workspace.execution === 'closed'} jobBar={<JobLimitsBar workspace={workspace} controls={controls} disabled={controlsDisabled} />} />}
              {workspace?.execution === 'closed' && <p>This project is closed. History is kept.</p>}
              {project ? <YourAgent projectName={project.name} user={user} tick={tick + agentTick} refresh={refresh} active={visible && currentSection === 'agents' && agentFilter === 'mine' && !agent} readOnly={workspace?.execution === 'closed'} go={go} /> : <p>The owner needs to set up this project before you can add an agent.</p>}
            </div>
            <div hidden={allAgents}><Agents user={user} agent={agent} search={search} filter={agentFilter} onAgent={onAgent} tick={tick + agentTick} active={visible && currentSection === 'agents' && !allAgents} go={go} waiting={openRequests.waiting} /></div>
          </div>
          {/* Native tasks replace GitHub Issues as the work record; repositories and pull requests stay where they are. */}
          {workspace && <div hidden={currentSection !== 'teams'}><ProjectTeams key={`${user.uid}:${projectId}`} api={teams} active={visible && currentSection === 'teams'} refreshToken={tick + teamsTick} disabledNotice={!nativeTeamsEnabled(workspace.nativeTeams)} agents={agentRows.page?.items ?? NO_AGENTS} lookup={project ? taskLabels : undefined} scope={`${user.uid}:${projectId}`} /></div>}
          {workspace && <div hidden={currentSection !== 'tasks'}><ProjectTasks key={`${user.uid}:${projectId}`} api={tasks} agents={taskAgents} people={taskPeople} lookup={project ? taskLabels : undefined} readOnly={workspace.role === 'guest' || workspace.execution === 'closed' || !ownProfileId || !nativeTasksEnabled(workspace.nativeTasks)} disabledNotice={!nativeTasksEnabled(workspace.nativeTasks)} active={visible && currentSection === 'tasks'} selfId={ownProfileId} manager={workspace.role === 'owner'} projectId={projectId} go={go} /></div>}
          <div hidden={currentSection !== 'conversations'}><Conversations user={user} thread={thread} messageId={messageId} tick={tick} active={visible && currentSection === 'conversations'} go={go} /></div>
          {/* One mounted composer owns the saved retry across Home and My agents. */}

        </>}
      </div>
      {/* Task 11: the people chat is a dock at the bottom right on every tab; the main column uses the full width. */}
    </div>
    </MyWorkersContext.Provider>
  );
}
