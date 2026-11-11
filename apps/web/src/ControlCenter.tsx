import { AgentCommunication } from './ui/AgentCommunication';
import { NativeTeamSettings } from './ui/NativeTeamSettings';
import { NativeTaskSettings } from './ui/NativeTaskSettings';
import { Button } from './ui/Button';
import { notify } from './ui/Toast';
import type { SessionUser } from './session-identity';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CardSettings } from './CardSettings';
import { projects, ApiError } from './api';
import './ui/project-setup.css';
import './ui/settings.css';
import { configureBody } from './project-settings';
import { repositoryUrl } from './proposal-form';
import { hold, type ControlCenterSection } from './route';
import { ControlCenterNavigation, controlCenterSections, visibleControlSections } from './ui/ControlCenterNavigation';
import type { Route } from './route';
import type { Workspace } from './project-api';
import { GitHubIcon } from './ui/GitHubIcon';
import type { ProjectControls } from './ui/ProjectControls';
import { ProjectControlsCard } from './ui/ProjectControls';
import { ProjectMerging } from './ProjectMerging';
import './ui/control-center.css';

type Pending = { path: string; body: object };

export function ControlCenter({ category, user, workspace, refresh, active, go, setControlsDisabled, controls, controlsDisabled = false, refreshKey }: { refreshKey: number; category?: ControlCenterSection; user: SessionUser; workspace: Workspace; setControlsDisabled: (disabled: boolean) => void; controls: ProjectControls; controlsDisabled?: boolean; refresh: () => void; active: boolean; go: (route: Route) => void }) {
  const [repo, setRepo] = useState(workspace.project?.repoUrl ?? workspace.definition.githubUrl ?? '');
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const [memberTick, setMemberTick] = useState(0);
  const [configurationDirty, setConfigurationDirty] = useState(false);
  const [configurationBase, setConfigurationBase] = useState(workspace.revision);
  const catalogRequest = useCallback(<T,>(path: string, body?: object) => projects<T>(user, path, body), [user]);
  const owner = workspace.role === 'owner';
  const tab = visibleControlSections({ owner }).find(item => item.id === category)?.id ?? 'status';
  const heading = useRef<HTMLHeadingElement>(null);
  const previousCategory = useRef(tab);
  useEffect(() => {
    if (!active || previousCategory.current === tab) return;
    previousCategory.current = tab;
    heading.current?.focus({ preventScroll: true });
  }, [active, tab]);
  const locked = busy || pending !== null;
  useEffect(() => locked || configurationDirty ? hold() : undefined, [locked, configurationDirty]);
  useEffect(() => {
    setControlsDisabled(active && (locked || configurationDirty));
    return () => setControlsDisabled(false);
  }, [active, locked, configurationDirty, setControlsDisabled]);
  useEffect(() => {
    if (!configurationDirty && !pending) {
      setRepo(workspace.project?.repoUrl ?? workspace.definition.githubUrl ?? '');
      setConfigurationBase(workspace.revision);
    }
  }, [workspace.revision, workspace.project?.repoUrl, workspace.definition.githubUrl, configurationDirty, pending]);
  async function execute(request: Pending) {
    setPending(request); setBusy(true); setError(null); setSaved(null);
    try {
      await projects(user, request.path, request.body);
      setPending(null);
      if (request.path.endsWith('/configure')) { setConfigurationDirty(false); setSaved('Repository saved.'); notify('Repository saved.'); }
      else setSaved('Project updated.');
      setMemberTick(t => t + 1); refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save. Retry the original request.');
      // The repository form sits far below the page's status line, so say it where the person is looking too.
      if (request.path.endsWith('/configure')) notify(e instanceof Error ? e.message : 'Could not save the repository.', 'error');
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && ![408, 429].includes(e.status)) { setPending(null); refresh(); }
    }
    finally { setBusy(false); }
  }
  const request = (suffix: string, body: object) => execute({ path: `/${workspace.id}/${suffix}`, body: { client_request_id: crypto.randomUUID(), ...body } });
  const repositorySettings = <form className="settings-form" onSubmit={e => {
      e.preventDefault();
      if (!repositoryUrl(repo)) { setError('Enter a GitHub repository such as github.com/owner/repository.'); return; }
      const body = configureBody(repo, configurationBase);
      if (body) void request('configure', body);
    }}>
      <fieldset disabled={busy || !!pending}>

        <label htmlFor="project-repo"><GitHubIcon />GitHub repository</label>
        <input id="project-repo" required value={repo} onChange={e => { setRepo(e.target.value); setConfigurationDirty(true); setSaved(null); }} placeholder="github.com/owner/repository" />
        <div className="settings-save-row"><Button disabled={!configurationDirty}>{busy ? 'Saving…' : 'Save repository'}</Button>
        {configurationDirty && <Button className="soft" type="button" onClick={() => { setConfigurationDirty(false); setError(null); refresh(); }}>Discard changes</Button>}</div>
      </fieldset>
    </form>;
  if (!owner) return active ? <p role="status">Settings are available to the project owner.</p> : null;
  const closed = workspace.execution === 'closed';
  return <section className={`project-settings control-center${active ? ' is-active' : ''}`} aria-labelledby="control-center-title">
    <header className="control-center-heading"><h2 id="control-center-title" className="k42-section-title">Settings</h2><p className="k42-section-intro">Manage project activity and rules.</p></header>
    <div className="control-center-layout">
    <ControlCenterNavigation projectId={workspace.id} section={tab} owner={owner} go={go} />
    <div className="control-center-panel">
    <h3 ref={heading} tabIndex={-1} className="settings-page-title">{controlCenterSections.find(item => item.id === tab)?.label}</h3>
    {closed && tab !== 'status' && <p>This project is closed. Reopen it in Project status to edit.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {saved && <p role="status">{saved}</p>}
    {pending && !busy && <div className="pending-action">
      <p>We couldn’t confirm this was saved.</p>
      <div className="actions"><Button disabled={busy} onClick={() => void execute(pending)}>Try again</Button><Button disabled={busy} onClick={() => { setPending(null); setError(null); refresh(); }}>Discard</Button></div>
    </div>}
    <div className="settings-category-pages">
      <section hidden={tab !== 'status'} className="settings-card">
        <ProjectControlsCard workspace={workspace} controls={controls} disabled={controlsDisabled} />
      </section>
      <section hidden={tab !== 'merging'}><ProjectMerging user={user} workspace={workspace} refresh={refresh} active={active && tab === 'merging'} refreshKey={refreshKey} /></section>
      <fieldset className="control-center-editable" disabled={closed} hidden={tab === 'status' || tab === 'merging'}>
      <section hidden={tab !== 'repository'} className="settings-card" aria-label="Repository">
        {owner ? repositorySettings : <p>GitHub repository: {workspace.project ? <a href={workspace.project.repoUrl} target="_blank" rel="noreferrer"><GitHubIcon />{workspace.project.repoUrl}</a> : 'Not set yet'}</p>}
      </section>
      <section hidden={tab !== 'agents'} className="settings-card" aria-label="Agent instructions">
        {/* The owner edits the Card, shared instructions included (server editCard). */}
        <CardSettings mode="guidance" request={catalogRequest} workspace={workspace} definition={workspace.definition} refresh={refresh} active={active && tab === 'agents'} />
        <AgentCommunication key={`${user.uid}:${workspace.id}:communication`} user={user} projectId={workspace.id} active={active && tab === 'agents'} tick={memberTick} />
      </section>
      <section hidden={tab !== 'features'} className="settings-card"><NativeTaskSettings key={`${user.uid}:${workspace.id}:tasks`} user={user} projectId={workspace.id} active={active && tab === 'features'} readOnly={closed} onSaved={() => refresh()} /><NativeTeamSettings key={`${user.uid}:${workspace.id}:teams`} user={user} projectId={workspace.id} active={active && tab === 'features'} readOnly={closed} onSaved={() => refresh()} /></section>
      </fieldset>
    </div>
    </div></div>
  </section>;
}
