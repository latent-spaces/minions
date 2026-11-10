import { PersonMergeAccess } from './MergeAccessControl';
import { githubRepositoryUrl, type MergePolicyView } from '@mlswarm/contracts';
import type { GitHubAccessObservation, GitHubCachedFacts, MergingPerson, ProjectMergingAccess } from '@mlswarm/contracts';
import { Button } from './Button';
import { GitHubMark } from './ProjectHeader';
import { githubStatus, personGitHubAccess, savedGitHubFact } from './github-access';

function AccessPaging({ first, next, previous, forward, label }: { first: boolean; next: string | null; previous: () => void; forward: () => void; label: string }) {
  return !first || next ? <nav className="k42-merging-pager" aria-label={`${label} pages`}><Button className="soft" disabled={first} onClick={previous}>Previous {label}</Button><Button className="soft" disabled={!next} onClick={forward}>Next {label}</Button></nav> : null;
}
const checked = (at: number | null) => at === null ? 'Not checked' : `Checked ${new Date(at).toLocaleString()}`;
const RULE_NAMES: Record<string, string> = { pull_request: 'Pull requests required', required_status_checks: 'Required checks',
  non_fast_forward: 'Force pushes blocked', deletion: 'Branch deletion restricted', required_linear_history: 'Linear history',
  required_signatures: 'Signed commits', merge_queue: 'Merge queue', required_deployments: 'Required deployments', update: 'Updates restricted', creation: 'Branch creation restricted' };
function FactState({ source, fact, at }: { source: GitHubAccessObservation; fact: GitHubCachedFacts[keyof GitHubCachedFacts]; at: number }) {
  return <span className="k42-merging-fact-state" title={checked(fact.lastSuccessAt)}>{githubStatus[fact.status]}{savedGitHubFact(source, fact, at) && ' · Saved results'}</span>;
}
function MergeRequirements({ source, at }: { source: GitHubAccessObservation | null; at: number }) {
  const rules = source?.rules.value, protection = source?.protection.value;
  const approvals = Math.max(rules?.requiredApprovals ?? 0, protection?.requiredApprovals ?? 0);
  const checks = [...new Set([...(rules?.requiredChecks ?? []), ...(protection?.requiredChecks ?? [])])];
  const types = [...new Set([...(rules?.types ?? []), ...(protection?.pullRequests ? ['pull_request'] : [])])].filter(type => type !== 'required_status_checks');
  return <section className="k42-merging-panel" aria-labelledby="merging-rules-title">
    <h3 id="merging-rules-title">Merge requirements{source?.access.value?.defaultBranch && <span className="muted"> · {source.access.value.defaultBranch}</span>}</h3>
    {source ? <>
      <div className="k42-merging-rule-sources"><span>Rulesets <FactState source={source} fact={source.rules} at={at} /></span><span>Branch protection <FactState source={source} fact={source.protection} at={at} /></span></div>
      {(rules || protection) && <ul className="k42-merging-requirements">
        {approvals > 0 && <li>{approvals} {approvals === 1 ? 'approval' : 'approvals'}</li>}
        {types.map(type => <li key={type}>{RULE_NAMES[type] ?? `Rule: ${type.replaceAll('_', ' ')}`}</li>)}
        {checks.map(check => <li key={`check:${check}`}>Check: {check}</li>)}
        {rules && !rules.complete && <li>More rules not shown</li>}
        {rules?.complete && !rules.types.length && <li>No rules reported</li>}
      </ul>}
    </> : <p className="muted">Not checked</p>}
  </section>;
}

export function MergingAccess({ data, peopleFirst, agentsFirst, previousPeople, nextPeople, previousAgents, nextAgents, changeMergeAccess, mergeAccessBusy, closed, mergeAccess }: {
  mergeAccess?: MergePolicyView | null;
  changeMergeAccess?: (personId: string, allow: boolean) => void; mergeAccessBusy?: boolean; closed?: boolean;
  data: ProjectMergingAccess; peopleFirst: boolean; agentsFirst: boolean;
  previousPeople: () => void; nextPeople: () => void; previousAgents: () => void; nextAgents: () => void;
}) {
  const repository = githubRepositoryUrl(data.repository);
  const source = data.github.project ?? data.github.self[0] ?? null;
  const people = new Map<string, MergingPerson>(data.people.map(person => [person.id, person]));
  for (const agent of data.agents) if (!people.has(agent.owner.id)) people.set(agent.owner.id, agent.owner);
  const paged = !peopleFirst || !agentsFirst || !!data.peopleNext || !!data.agentsNext;
  return <>
    <section className="k42-merging-panel k42-merging-github" aria-label="GitHub check">
      <GitHubMark size={24} />
      <div><strong>{repository ? <a href={repository} target="_blank" rel="noreferrer">{repository.replace('https://github.com/', '')}<span className="visually-hidden"> (opens in a new tab)</span></a> : 'Repository not configured'}</strong>
        <p>{source ? <>
          {source.account.value && <span>via @{source.account.value.login} · </span>}
          <span>{checked(source.access.lastSuccessAt)}</span>
          {!source.online && <span> · Local service offline</span>}
          {source.access.status !== 'ok' && <span> · {githubStatus[source.access.status]}</span>}
          {savedGitHubFact(source, source.access, data.generatedAt) && <span> · Saved results</span>}
        </> : 'Not checked · Start MyLittleSwarm on your computer'}</p>
      </div>
    </section>
    <section className="k42-merging-panel" aria-labelledby="merging-people-title">
      <div className="k42-merging-section-heading"><h3 id="merging-people-title">People and agents</h3>{paged && <span className="muted">Loaded pages</span>}</div>
      <table className="k42-merging-table"><thead><tr><th>Person</th><th>GitHub account</th><th>GitHub access</th>{mergeAccess?.policy.mode === 'selected_people' && <th>Merge access</th>}<th>Agents</th></tr></thead>
        <tbody>{[...people.values()].map(person => {
          const access = personGitHubAccess(data, person), agents = data.agents.filter(agent => agent.owner.id === person.id);
          return <tr key={person.id}>
            <td data-label="Person"><strong>{person.name}</strong><small className="muted">{person.role}</small></td>
            <td data-label="GitHub account">{access.login ? <><a href={`https://github.com/${encodeURIComponent(access.login)}`} target="_blank" rel="noreferrer">@{access.login}<span className="visually-hidden"> (opens in a new tab)</span></a>{access.signInOnly && <small className="muted">Sign-in identity</small>}</> : 'Not recorded'}</td>
            <td data-label="GitHub access"><span title={access.fact ? checked(access.fact.lastSuccessAt) : undefined}>{access.label}</span>{access.fact && access.fact.status !== 'ok' && access.fact.status !== 'not_checked' && <small className="muted">{githubStatus[access.fact.status]}</small>}{access.source && access.fact && savedGitHubFact(access.source, access.fact, data.generatedAt) && <small className="muted">Saved results</small>}</td>
            {mergeAccess?.policy.mode === 'selected_people' && <td data-label="Merge access"><PersonMergeAccess person={person} value={mergeAccess} editable={!!changeMergeAccess && !closed} disabled={mergeAccessBusy} onChange={changeMergeAccess} /></td>}
            <td data-label="Agents">{agents.length ? <ul className="k42-merging-agent-names">{agents.map(agent => <li key={agent.id}>{agent.name}{agent.connection !== 'current' && <span className="muted"> · {agent.connection}</span>}</li>)}</ul> : <span className="muted">{data.agentsNext || !agentsFirst ? 'None on this page' : 'None registered'}</span>}</td>
          </tr>;
        })}</tbody></table>
      {!people.size && <p className="muted">No records on this page.</p>}
      <AccessPaging first={peopleFirst} next={data.peopleNext} previous={previousPeople} forward={nextPeople} label="people" />
      <AccessPaging first={agentsFirst} next={data.agentsNext} previous={previousAgents} forward={nextAgents} label="agents" />
    </section>
    <MergeRequirements source={data.github.project} at={data.generatedAt} />
    <details className="k42-merging-panel k42-merging-disclosure"><summary>Access details</summary>
      <p>Checks use an approved computer’s GitHub login. Sign-in identity does not prove a worker uses that account.</p>
      <p>Invitations and partial results do not prove access. A missing name stays unknown. Grant history is unavailable. GitHub may apply bypass permissions.</p>
      {data.github.project && <p>Repository report by {data.github.project.observer.name} · {checked(data.github.project.receivedAt)}</p>}
      <ul className="k42-merging-evidence">{[...people.values()].map(person => {
        const access = personGitHubAccess(data, person);
        return access.source && access.fact ? <li key={person.id}>{person.name} · {access.source.observer.name}’s computer · {checked(access.fact.lastSuccessAt)}</li> : null;
      })}</ul>
      {data.github.project && <p>Rulesets · {checked(data.github.project.rules.lastSuccessAt)}<br />Branch protection · {checked(data.github.project.protection.lastSuccessAt)}</p>}
      {source && <p>Collaborators: <FactState source={source} fact={source.collaborators} at={data.generatedAt} />{source.collaborators.value && !source.collaborators.value.complete && ' · Partial list'}<br />Invitations: <FactState source={source} fact={source.invitations} at={data.generatedAt} />{source.invitations.value && !source.invitations.value.complete && ' · Partial list'}</p>}
      {source?.invitations.value?.people.length ? <ul>{source.invitations.value.people.map(invite => <li key={invite.login}>@{invite.login} · Invited{invite.invitedBy ? ` by @${invite.invitedBy}` : ' · Inviter unknown'}</li>)}</ul> : null}
      {data.github.more && <p>More computer reports are available.</p>}
      {repository && <div className="k42-merging-links"><a href={`${repository}/settings/access`} target="_blank" rel="noreferrer">GitHub access ↗</a><a href={`${repository}/settings/rules`} target="_blank" rel="noreferrer">GitHub rules ↗</a></div>}
    </details>
  </>;
}
