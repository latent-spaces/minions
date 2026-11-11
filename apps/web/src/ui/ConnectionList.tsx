import { Plug } from 'lucide-react';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import type { Computer } from './ComputerSetup';
import './connection-list.css';

export function ConnectionList({ connections, busy, revoke }: {
  connections: Computer[]; busy: string | null; revoke: (connection: Computer) => void;
}) {
  if (connections.length === 0) return <div className="k42-connection-list"><EmptyState icon={Plug} title="No connections yet.">
    When you add an agent from Claude Code or Codex, approve this computer and it shows up here.
  </EmptyState></div>;
  return <ul className="k42-connection-list" aria-label="Connections">{connections.map(connection => <li key={connection.id}>
    <div className="k42-connection-detail"><strong>{connection.clientName}</strong>
      <p className="muted">{connection.revocationPending ? 'Revoked · finishing its agents' : <>
        {connection.runtime ? connection.runtime.online ? 'Online' : 'Offline' : 'No status yet'} · Approval expires <time dateTime={new Date(connection.expiresAt).toISOString()}>{new Date(connection.expiresAt).toLocaleDateString()}</time>
      </>}</p>
    </div>
    <Button className="danger" disabled={busy !== null} onClick={() => revoke(connection)} aria-label={`${connection.revocationPending ? 'Finish revoking' : 'Revoke'} ${connection.clientName}`}>
      {busy === connection.id ? 'Revoking…' : connection.revocationPending ? 'Finish revoking' : 'Revoke'}
    </Button>
  </li>)}</ul>;
}
