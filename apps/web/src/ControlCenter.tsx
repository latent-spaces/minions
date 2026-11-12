import { Users } from 'lucide-react';
import { AgentCommunication } from './ui/AgentCommunication';
import { NativeTeamSettings } from './ui/NativeTeamSettings';
import { NativeTaskSettings } from './ui/NativeTaskSettings';
import type { SessionUser } from './session-identity';
import { useCallback } from 'react';
import { CardSettings } from './CardSettings';
import { projects } from './api';
import './ui/project-setup.css';
import './ui/settings.css';
import type { Workspace } from './project-api';
import { Connections } from './ui/Connections';
import './ui/control-center.css';
import { MyCharacter } from './ui/MyCharacter';

// Settings is one page (owner decision, 11 November 2026): Agents, Features and Connections, each explained behind a ? note.
// Pause, Close and Reopen moved to the project header (owner, 12 November 2026).
export function ControlCenter({ user, workspace, refresh, active, refreshKey }: { refreshKey: number; user: SessionUser; workspace: Workspace; refresh: () => void; active: boolean }) {
  const catalogRequest = useCallback(<T,>(path: string, body?: object) => projects<T>(user, path, body), [user]);
  const isOwner = workspace.role === 'owner';
  const closed = workspace.execution === 'closed';
  return <section className={`project-settings control-center${active ? ' is-active' : ''}`} aria-labelledby="control-center-title">
    <header className="control-center-heading"><h2 id="control-center-title" className="k42-section-title">Settings</h2></header>
    <div className="settings-category-pages control-center-stack">
      <MyCharacter key={user.uid} user={user} active={active} onSaved={refresh} />
      {isOwner && <>
      {closed && <p className="muted">This project is closed. Reopen it from the project header to edit these settings.</p>}
      <fieldset className="control-center-editable control-center-stack" disabled={closed}>
        <section className="settings-card" aria-labelledby="settings-agents-title">
          <header className="settings-group-title settings-group-head"><span className="settings-group-icon" aria-hidden="true"><Users size={18} /></span><div><h3 id="settings-agents-title">All agents</h3><p>Every agent in this project follows these, yours and other people’s.</p></div></header>
          {/* The owner edits the Card, shared instructions included (server editCard). */}
          <CardSettings mode="guidance" request={catalogRequest} workspace={workspace} definition={workspace.definition} refresh={refresh} active={active} />
          <AgentCommunication key={`${user.uid}:${workspace.id}:communication`} user={user} projectId={workspace.id} active={active} tick={refreshKey} />
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
