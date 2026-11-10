import { useEffect, useId, useState } from 'react';
import type { MergePolicyView, ProjectMergePolicy } from '@mlswarm/contracts';
import type { MergeAccessActions } from '../merge-access';
import { Button } from './Button';
import './merge-access.css';

const statusText: Record<MergePolicyView['enforcement']['state'], string> = {
  not_enabled: 'Selected-people enforcement is off.',
  pending: 'Pending GitHub synchronization. Start MyLittleSwarm on the project owner’s computer.',
  verified: 'Verified on GitHub. Only the owner and selected people can merge through PRs.',
  stale: 'GitHub verification is out of date. Start MyLittleSwarm on the project owner’s computer to check again.',
  failed: 'GitHub enforcement could not be verified.',
};
const reasons: Partial<Record<NonNullable<MergePolicyView['enforcement']['code']>, string>> = {
  empty_repository: 'Create the repository’s initial default branch before enabling merge enforcement. The owner’s computer will retry.',
  github_permissions: 'The owner’s GitHub account needs repository administration access and a plan that supports rulesets for this repository.',
  github_unavailable: 'GitHub could not be reached. The owner’s computer will retry.',
  account_mismatch: 'Sign in to GitHub CLI with the project owner’s verified GitHub account.',
  verification_failed: 'The saved GitHub rule did not match. Check the repository rules.',
  conflicting_rulesets: 'Another project or a duplicate MyLittleSwarm ruleset controls this repository. Resolve it in GitHub before retrying.',
  identity_required: 'The owner or a selected person needs a verified GitHub sign-in. Until then their merge access cannot be confirmed.',
  too_many_members: 'This project exceeds the supported synchronization size. Contact the MyLittleSwarm team.',
};
export function MergeAccessControl({ value, busy, closed, save, refresh }: {
  value: MergePolicyView; busy: boolean; closed: boolean;
  save: (mode: ProjectMergePolicy['mode']) => void; refresh: () => void;
}) {
  const id = useId();
  const [mode, setMode] = useState(value.policy.mode);
  useEffect(() => setMode(value.policy.mode), [value.policy.mode, value.policy.revision]);
  return <section className="k42-merging-panel" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>Who can merge</h3>
    <p>The owner can give merge access to selected people. Their agents use the same GitHub account permissions.</p>
    <form className="settings-form" onSubmit={event => { event.preventDefault(); save(mode); }}>
      <label htmlFor={`${id}-mode`}>Merge access</label>
      <select id={`${id}-mode`} value={mode} disabled={busy || closed} onChange={event => setMode(event.target.value as ProjectMergePolicy['mode'])}>
        <option value="existing">Use existing GitHub permissions</option>
        <option value="selected_people">Selected people can merge</option>
      </select>
      <p className="muted">Selected people: the owner is included automatically. Everyone else can push working branches and open PRs. Direct pushes to main and the default branch are blocked for everyone. Existing GitHub checks and review rules still apply.</p>
      <div><Button type="submit" disabled={busy || closed || mode === value.policy.mode}>{busy ? 'Saving…' : 'Save merge access'}</Button></div>
    </form>
    <MergeAccessStatus value={value} />
    <p className="muted">Grants and revocations take effect after GitHub synchronization. GitHub administrators can still edit repository rules.</p>
    <Button className="soft" disabled={busy} onClick={refresh}>Refresh enforcement</Button>
  </section>;
}

function MergeAccessStatus({ value }: { value: MergePolicyView }) {
  return <><p role="status">{statusText[value.enforcement.state]}</p>
    {value.enforcement.code && reasons[value.enforcement.code] && <p className="muted">{reasons[value.enforcement.code]}</p>}
    {value.enforcement.checkedAt !== null && <p className="muted">Checked {new Date(value.enforcement.checkedAt).toLocaleString()}</p>}</>;
}
export function MergeAccessFeedback({ access }: { access: MergeAccessActions }) {
  return <>{access.error && <p role="alert" className="error">{access.error}</p>}{access.notice && <p role="status">{access.notice}</p>}
    {access.pending && !access.busy && <div><p>We couldn’t confirm this change. Retry the original request or discard and reload.</p><div className="actions"><Button onClick={access.retry}>Retry original merge change</Button><Button onClick={access.discard}>Discard and reload merge access</Button></div></div>}</>;
}
export function PersonMergeAccess({ person, value, editable = false, disabled = false, onChange }: {
  person: { id: string; name: string; role: 'owner' | 'member' }; value: MergePolicyView; editable?: boolean; disabled?: boolean; onChange?: (personId: string, allow: boolean) => void;
}) {
  if (value.policy.mode !== 'selected_people') return null;
  const automatic = person.role === 'owner', selected = value.policy.selected.some(row => row.profileId === person.id);
  return <div className="k42-person-merge-access"><span>{automatic ? `Can merge · ${person.role}` : selected ? 'Can merge' : 'PRs only'}</span>
    {editable && !automatic && <Button className="soft" disabled={disabled} aria-label={`${selected ? 'Revoke' : 'Grant'} merge access for ${person.name}`} onClick={() => onChange?.(person.id, !selected)}>{selected ? 'Revoke merge access' : 'Grant merge access'}</Button>}</div>;
}
