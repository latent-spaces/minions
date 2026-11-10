import { MERGE_APPROVALS, MERGE_APPROVAL_TEXT, type MergeApproval } from '../merge-approval';
import './merge-approval.css';

// The project merge policy: who may approve and merge pull requests into the main branch. Agents follow it as an
// instruction; it locks nothing on GitHub, where the repository's own rules still apply.
export function MergeApprovalControl({ id, value, onChange, disabled = false }: {
  id: string; value: MergeApproval; onChange: (value: MergeApproval) => void; disabled?: boolean;
}) {
  const index = MERGE_APPROVALS.indexOf(value), text = MERGE_APPROVAL_TEXT[value];
  return <fieldset className="k42-merge-policy" disabled={disabled}>
    <legend>Who may approve and merge?</legend>
    <input id={id} aria-label="Who may approve and merge?" type="range" min={0} max={MERGE_APPROVALS.length - 1} step={1} value={index}
      aria-valuetext={`${text.name}: ${text.who}`} aria-describedby={`${id}-help`}
      onChange={e => onChange(MERGE_APPROVALS[Number(e.target.value)])} />
    <ol className="k42-merge-policy-stops" aria-hidden="true">{MERGE_APPROVALS.map(stop => <li key={stop} className={stop === value ? 'selected' : undefined}>
      <button type="button" tabIndex={-1} onClick={() => onChange(stop)}>{MERGE_APPROVAL_TEXT[stop].name}</button>
    </li>)}</ol>
    <p id={`${id}-help`} className="k42-merge-policy-help"><strong>{text.who}</strong> {text.detail}</p>
  </fieldset>;
}

