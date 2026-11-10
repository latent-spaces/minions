import { Laptop } from 'lucide-react';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import type { Computer } from './ComputerSetup';
import './my-computers.css';

export function MyComputersPage({ computers, busy, revoke }: {
  computers: Computer[]; busy: string | null; revoke: (computer: Computer) => void;
}) {
  if (computers.length === 0) return <div className="k42-computers-list"><EmptyState icon={Laptop} title="No connected computers.">
    Computers you approve from your coding agent will appear here.
  </EmptyState></div>;
  return <ul className="k42-computers-list" aria-label="Connected computers">{computers.map(computer => <li key={computer.id}>
    <div className="k42-computer-detail"><strong>{computer.clientName}</strong>
      <p className="muted">{computer.revocationPending ? 'Access revoked · finishing agent revocation' : <>
        {computer.runtime ? computer.runtime.online ? 'Online' : 'Offline' : 'No status reported'} · Approval expires <time dateTime={new Date(computer.expiresAt).toISOString()}>{new Date(computer.expiresAt).toLocaleDateString()}</time>
      </>}</p>
    </div>
    <Button className="danger" disabled={busy !== null} onClick={() => revoke(computer)} aria-label={`${computer.revocationPending ? 'Finish revoking' : 'Revoke access for'} ${computer.clientName}`}>
      {busy === computer.id ? 'Revoking…' : computer.revocationPending ? 'Finish revoking' : 'Revoke access'}
    </Button>
  </li>)}</ul>;
}
