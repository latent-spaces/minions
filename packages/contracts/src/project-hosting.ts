/** Native hosting protocol. Limits are engineering bounds, not free-plan promises. */
export const HOSTING_LIMITS = Object.freeze({
  files: 2_000, artifactBytes: 20 * 1024 * 1024, fileBytes: 8 * 1024 * 1024,
  manifestBytes: 512 * 1024, pathBytes: 240, depth: 16, releaseReferences: 100, headBytes: 32 * 1024, cleanupBatch: 200,
  retirementGraceMs: 24 * 60 * 60 * 1000,
  retainedBytes: 100 * 1024 * 1024, stagingTtlMs: 60 * 60 * 1000,
});
export type HostingFile = { path: string; bytes: number; sha256: string; mime: string };
export type HostingManifest = { version: 1; entry: string; files: HostingFile[] };
export type HostingArtifact = { digest: string; manifest: HostingManifest; bytes: number };
export type HostingPolicy = {
  revision: number; enabled: boolean; audience: 'public';
  mode: 'approval' | 'automatic';
  approvers: { profileId: string; epoch: number }[];
  submitters: { profileId: string; epoch: number }[];
};
export type HostingOperationState = 'queued' | 'applying' | 'published' | 'unpublished' | 'uncertain' | 'superseded' | 'failed';
export type HostingRelease = { artifact: string; buildId: string; bytes: number; retiredAt: number | null };
/** The serving authority is read before EVERY response, including cached assets. */
export type HostingServingHead = {
  version: 1; revision: number; generation: number; operationId: string; intent: string;
  disabled: boolean; current: string | null; releases: HostingRelease[];
};
export type HostingCandidateSummary = {
  id: string; state: 'uploading' | 'ready' | 'expired' | 'deleting'; digest: string; bytes: number;
  files: number; createdAt: number; expiresAt: number; policyRevision: number;
  submittedBy: { profileId: string; name: string; agentId: string | null };
  lastPublishedAt: number | null;
};
export type HostingSummary = {
  configured: boolean; policy: HostingPolicy; observedArtifact: string | null; observedCandidate: string | null;
  publishedUrl: string | null; reservedBytes: number; candidateCount: number;
  operation: { id: string; state: HostingOperationState; artifact: string | null; attempts: number; updatedAt: number } | null;
  candidates: HostingCandidateSummary[]; next: string | null;
};
const HOSTING_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
/** Reserved service labels cannot collide with canonical 52-character project hosts.
 * Control uses only server-held Bearer credentials, never parent-domain cookies.
 */
export function hostingControlHostAllowed(control: string, content: string): boolean {
  return control === `control.${content}` || control === `control-staging.${content}`
    || control !== content && !control.endsWith(`.${content}`);
}
/** A SHA-256 ID becomes one canonical 52-character DNS label, without truncating identity. */
export function hostingProjectLabel(project: string): string {
  if (!/^[a-f0-9]{64}$/.test(project)) throw new Error('Invalid hosting project ID.');
  let accumulator = 0, bits = 0, label = '';
  for (let index = 0; index < project.length; index += 2) {
    accumulator = (accumulator << 8) | Number.parseInt(project.slice(index, index + 2), 16); bits += 8;
    while (bits >= 5) { bits -= 5; label += HOSTING_ALPHABET[(accumulator >>> bits) & 31]; }
  }
  if (bits) label += HOSTING_ALPHABET[(accumulator << (5 - bits)) & 31];
  return label;
}
export function hostingProjectFromLabel(label: string): string | null {
  if (!/^[a-z2-7]{52}$/.test(label)) return null;
  let accumulator = 0, bits = 0, project = '';
  for (const character of label) {
    accumulator = (accumulator << 5) | HOSTING_ALPHABET.indexOf(character); bits += 5;
    if (bits >= 8) { bits -= 8; project += ((accumulator >>> bits) & 255).toString(16).padStart(2, '0'); }
  }
  return project.length === 64 && hostingProjectLabel(project) === label ? project : null;
}
export function hostingContentHost(project: string, domain: string): string {
  if (!/^[a-f0-9]{64}$/.test(project) || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)
    || domain.split('.').some(label => label.length > 63) || domain.length > 180) throw new Error('Invalid content hostname configuration.');
  return `${hostingProjectLabel(project)}.${domain}`;
}
