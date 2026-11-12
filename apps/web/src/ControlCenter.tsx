import { CommunicationLimits } from './ui/CommunicationLimits';
import { NativeTeamSettings } from './ui/NativeTeamSettings';
import { NativeTaskSettings } from './ui/NativeTaskSettings';
import type { SessionUser } from './session-identity';
import { useCallback } from 'react';
import { CardSettings } from './CardSettings';
import { projects } from './api';
import './ui/project-setup.css';
import './ui/settings.css';
import type { Workspace } from './project-api';
import type { ProjectControls } from './ui/ProjectControls';
import { ProjectControlsCard } from './ui/ProjectControls';
import { Connections } from './ui/Connections';
import './ui/control-center.css';
import { MyCharacter } from './ui/MyCharacter';

// Settings is one page (owner decision, 11 November 2026): Project, Agents, Features and Connections, each explained behind a ? note.
export function ControlCenter({ user, workspace, refresh, active, controls, refreshKey }: { refreshKey: number; user: SessionUser; workspace: Workspace; controls: ProjectControls; refresh: () => void; active: boolean }) {
  const catalogRequest = useCallback(<T,>(path: string, body?: object) => projects<T>(user, path, body), [user]);
  const isOwner = workspace.role === 'owner';
  const closed = workspace.execution === 'closed';
  return <section className={`project-settings control-center${active ? ' is-active' : ''}`} aria-labelledby="control-center-title">
    <header className="control-center-heading"><h2 id="control-center-title" className="k42-section-title">Settings</h2></header>
    <div className="settings-category-pages control-center-stack">
      <MyCharacter key={user.uid} user={user} active={active} onSaved={refresh} />
      {isOwner && <>
      <section className="settings-card" aria-labelledby="settings-project-title">
        <h3 id="settings-project-title" className="settings-group-title">Project</h3>
        <ProjectControlsCard workspace={workspace} controls={controls} />
      </section>
      {closed && <p className="muted">This project is closed. Reopen it to edit the settings below.</p>}
      <fieldset className="control-center-editable control-center-stack" disabled={closed}>
        <section className="settings-card" aria-labelledby="settings-agents-title">
          <h3 id="settings-agents-title" className="settings-group-title">Agents</h3>
          {/* The owner edits the Card, shared instructions included (server editCard). */}
          <CardSettings mode="guidance" request={catalogRequest} workspace={workspace} definition={workspace.definition} refresh={refresh} active={active} />
          <CommunicationLimits key={`${user.uid}:${workspace.id}:communication`} user={user} projectId={workspace.id} active={active} tick={refreshKey} />
        </section>
        <section className="settings-card" aria-labelledby="settings-features-title">
          <h3 id="settings-features-title" className="settings-group-title">Features</h3>
          <NativeTaskSettings key={`${user.uid}:${workspace.id}:tasks`} user={user} projectId={workspace.id} active={active} readOnly={closed} onSaved={() => refresh()} />
          <NativeTeamSettings key={`${user.uid}:${workspace.id}:teams`} user={user} projectId={workspace.id} active={active} readOnly={closed} onSaved={() => refresh()} />
        </section>
      </fieldset>
      <Connections key={`${user.uid}:connections`} user={user} active={active} refreshKey={refreshKey} retry={refresh} />
      </>}
    </div>
  </section>;
}
