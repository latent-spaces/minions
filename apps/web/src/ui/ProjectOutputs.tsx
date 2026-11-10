import { useEffect, useId, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { HostingArtifact, HostingCandidateSummary, HostingSummary } from '@mlswarm/contracts';
import { Button } from './Button';
import { PublishedOutputViewer } from './PublishedOutputViewer';
import './project-outputs.css';

export type OutputsProps = {
  summary: HostingSummary | null; owner: boolean; profileId: string; closed: boolean; title: string;
  error: string; busy: boolean; url: string | null;
  onRefresh: () => void; onNext: () => void; onFirst: () => void;
  onPublish: (candidate: HostingCandidateSummary) => void; onUnpublish: () => void; onRetryOperation: () => void;
  inspected: { candidateId: string; artifact: HostingArtifact } | null; onInspect: (id: string) => void;
};
export function ProjectOutputs(props: OutputsProps) {
  const { summary, owner, profileId, busy, closed, url } = props;
  const label = useId();
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const [filesShown, setFilesShown] = useState(50);
  useEffect(() => setFilesShown(50), [props.inspected?.candidateId]);
  const canSubmit = summary?.policy.enabled && summary.policy.submitters.some(p => p.profileId === profileId);
  const canApprove = summary?.policy.enabled && summary.policy.approvers.some(p => p.profileId === profileId);
  const reviewCandidate = summary?.candidates.find(candidate => candidate.id === props.inspected?.candidateId)
    ?? summary?.candidates.find(candidate => candidate.state === 'ready' && candidate.lastPublishedAt === null && candidate.id !== summary.observedCandidate && candidate.policyRevision === summary.policy.revision);
  return <section className="k42-outputs" aria-labelledby={label}>
    <header className="k42-outputs-heading"><h2 id={label}>Outputs</h2><Button onClick={props.onRefresh} disabled={busy}><RefreshCw size={16} aria-hidden="true" />Refresh</Button></header>
    {props.error && <p className="k42-outputs-error" role="alert">{props.error}</p>}
    {!summary ? <p role="status">Loading project outputs…</p> : <>
      <div className="k42-outputs-columns">
        <div className="k42-outputs-view">
          <PublishedOutputViewer title={props.title} url={url} />
          <section aria-label="Builds"><h3>Builds</h3>
            {!summary.candidates.length && <p>No builds have been uploaded.</p>}
            <ul className="k42-outputs-builds">{summary.candidates.map(candidate => <li key={candidate.id}>
              <div><strong>Build {candidate.digest.slice(0, 10)}</strong><span>{candidate.files} {candidate.files === 1 ? 'file' : 'files'} · {(candidate.bytes / 1024).toFixed(1)} KiB</span><span>Submitted by {candidate.submittedBy.name}{candidate.submittedBy.agentId ? ' · agent build' : ''}</span>
                <span>{candidate.id === summary.observedCandidate ? 'Last confirmed public release' : candidate.lastPublishedAt !== null ? 'Previously published build' : candidate.state === 'ready' ? 'Ready build' : candidate.state === 'expired' ? 'Upload expired' : candidate.state === 'deleting' ? 'Cleanup in progress' : 'Upload in progress'}</span></div>
              {(owner || canApprove || canSubmit || candidate.submittedBy.profileId === profileId) && <Button onClick={() => props.onInspect(candidate.id)} disabled={busy || candidate.state === 'deleting'}>Review files</Button>}
              {candidate.policyRevision !== summary.policy.revision && <span>Policy changed · upload a new candidate</span>}
            </li>)}</ul>
            <nav aria-label="Build pages"><Button onClick={props.onFirst} disabled={busy}>First page</Button>{summary.next && <Button onClick={props.onNext} disabled={busy}>More builds</Button>}</nav>
          </section>
        </div>
        <aside className="k42-outputs-controls" aria-label="Publication controls">
          {reviewCandidate && <section aria-label="Build review"><h3>{reviewCandidate.id === summary.observedCandidate ? 'Published build' : reviewCandidate.lastPublishedAt !== null ? 'Previously published build' : reviewCandidate.state === 'ready' ? 'Candidate ready for review' : reviewCandidate.state === 'expired' ? 'Upload expired' : reviewCandidate.state === 'deleting' ? 'Cleanup in progress' : 'Candidate upload in progress'}</h3><p>Build {reviewCandidate.digest.slice(0, 10)} · {reviewCandidate.files} {reviewCandidate.files === 1 ? 'file' : 'files'} · {(reviewCandidate.bytes / 1024).toFixed(1)} KiB</p><p>Submitted by {reviewCandidate.submittedBy.name}</p>
            <p>{reviewCandidate.id === summary.observedCandidate ? 'Last confirmed public release' : summary.operation?.artifact === reviewCandidate.digest ? 'Activation is awaiting confirmation' : reviewCandidate.lastPublishedAt !== null ? 'This build was previously published' : 'This build has not been published'}</p>
            {(owner || canApprove || canSubmit) && <Button disabled={busy} onClick={() => props.onInspect(reviewCandidate.id)}>Review build files</Button>}
            {reviewCandidate.state === 'ready' && reviewCandidate.id !== summary.observedCandidate && reviewCandidate.policyRevision === summary.policy.revision && <Button className="primary" disabled={busy || closed || !summary.configured || !!summary.operation || (summary.policy.mode === 'approval' ? !canApprove : !canSubmit)} onClick={() => props.onPublish(reviewCandidate)}>{summary.policy.mode === 'approval' ? 'Approve this build' : 'Publish this build'}</Button>}
          </section>}
          {props.inspected && <section aria-label="Exact build inventory"><h3>Files in this build</h3><p>Approval makes these files public. Test the local build before approving it.</p><code>{props.inspected.artifact.digest}</code><ul className="k42-outputs-file-list">{props.inspected.artifact.manifest.files.slice(0, filesShown).map(file => <li key={file.path}><span>{file.path}</span><span>{file.bytes.toLocaleString()} bytes</span></li>)}</ul>{filesShown < props.inspected.artifact.manifest.files.length && <Button onClick={() => setFilesShown(value => value + 50)}>Show more files</Button>}</section>}
          {summary.operation && <section aria-label="Pending publication"><h3>Publication {summary.operation.state}</h3><p>Activation is confirmed separately from upload.</p><Button disabled={busy || !summary.configured} onClick={props.onRetryOperation}>Check and retry operation</Button></section>}
          {owner && (url || summary.operation || summary.policy.enabled) && <section><label><input type="checkbox" checked={confirmUnpublish} onChange={event => setConfirmUnpublish(event.target.checked)} disabled={busy} />Unpublish this output and disable updates</label><Button disabled={busy || !summary.configured || !confirmUnpublish} onClick={props.onUnpublish}>Unpublish</Button></section>}
        </aside>
      </div>
    </>}
  </section>;
}
