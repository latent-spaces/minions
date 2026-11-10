import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HOSTING_LIMITS, artifactPath, artifactMime, parseArtifact, sha256, boundedBytes } from '../runtime/hosting-contract.mjs';

export const PROJECT_OUTPUT_TOOL = {
  name: 'upload_project_output',
  description: 'Prepare a static project output from a clean built folder inside this agent’s approved working folder. Supply an absolute directoryPath and stable clientRequestId; keep the same files and ID for retries. All included files may become public under the project owner’s hosting policy. index.html is required. This tool does not run build commands, install dependencies or start models. Only current owner-designated submitters may upload. Approval mode prepares a candidate for a designated person; automatic mode requests publication of the completed eligible build. Upload/seal/activation are separate states; an unconfirmed reply is not Published. Never include credentials, repository metadata or private files. Max 20 MiB total, 8 MiB per file, 2,000 files. Browser games and other static sites are supported; server code is not executed.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: { type: 'object', additionalProperties: false, required: ['directoryPath', 'clientRequestId'], properties: {
    directoryPath: { type: 'string', maxLength: 4096, description: 'Absolute clean built output folder inside this agent’s approved working folder.' },
    clientRequestId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$', description: 'Keep the same ID and original files after an uncertain response.' },
  } },
};
const refuse = message => { throw new Error(message); };
const inside = (root, path) => { const value = relative(root, path); return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value); };
async function checkedFile(root, path, expected) {
  const before = await lstat(path);
  if (!Number.isSafeInteger(before.ino) || before.ino < 1) refuse('This filesystem cannot verify stable file identity. Use a filesystem with stable file IDs.');
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1
    || before.size > HOSTING_LIMITS.fileBytes || !inside(root, await realpath(path))) refuse('Use ordinary, unlinked static files inside the approved output folder.');
  let handle;
  try {
    // Some Windows builds omit these flags. Identity and containment checks remain mandatory.
    const flags = constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0)
      | (typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0);
    handle = await open(path, flags);
    const current = await handle.stat();
    if (!current.isFile() || current.ino !== before.ino || current.dev !== before.dev || current.nlink !== 1) refuse('The output folder changed. Finish the build and retry.');
    const bytes = Buffer.alloc(before.size + 1); let used = 0;
    while (used < bytes.length) {
      const result = await handle.read(bytes, used, bytes.length - used, null);
      if (!result.bytesRead) break;
      used += result.bytesRead;
    }
    const after = await handle.stat();
    if (used !== before.size || after.size !== before.size || after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs
      || !inside(root, await realpath(path))) refuse('The output folder changed. Finish the build and retry.');
    const value = bytes.subarray(0, used);
    if (expected && (value.length !== expected.bytes || await sha256(value) !== expected.sha256)) refuse('The output changed after reservation. Keep original files for this request ID.');
    return value;
  } finally { await handle?.close(); }
}
/** Read/hash one file at a time; retain only the inventory, never a whole build in memory. */
export async function inspectProjectOutput(folder, directoryPath) {
  if (typeof directoryPath !== 'string' || !isAbsolute(directoryPath) || directoryPath.length > 4096 || directoryPath.includes('\0')) refuse('Choose an absolute output directory.');
  const root = await realpath(folder), selected = resolve(directoryPath), lexicalRoot = resolve(folder);
  const parent = relative(lexicalRoot, selected) === '' || inside(lexicalRoot, selected) ? lexicalRoot : root;
  if (relative(parent, selected) !== '' && !inside(parent, selected)) refuse('Choose an output folder inside the approved working folder.');
  let current = parent;
  // Check each selected parent, including Windows junctions as reported by lstat.
  for (const component of relative(parent, selected).split(sep).filter(Boolean)) {
    current = join(current, component);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) refuse('Output folders cannot contain symbolic links or junctions.');
  }
  const canonical = await realpath(selected);
  if (canonical !== root && !inside(root, canonical)) refuse('Output folder escapes the approved working folder.');
  const inventory = []; let total = 0, visited = 0;
  async function walk(path, prefix = '', depth = 0) {
    if (depth > HOSTING_LIMITS.depth) refuse('Output folder is too deep.');
    // opendir-style bounds are enforced before sorting/allocating a whole unbounded tree.
    const { opendir } = await import('node:fs/promises');
    const directory = await opendir(path);
    for await (const entry of directory) {
      if (++visited > HOSTING_LIMITS.files * 2) refuse('Output folder has too many entries.');
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      artifactPath(name);
      const filePath = join(path, entry.name), stat = await lstat(filePath);
      if (stat.isSymbolicLink()) refuse('Static output cannot include symbolic links or junctions.');
      if (stat.isDirectory()) { await walk(filePath, name, depth + 1); continue; }
      if (inventory.length >= HOSTING_LIMITS.files) refuse('Output folder has too many files.');
      const mime = artifactMime(name);
      if (total + stat.size > HOSTING_LIMITS.artifactBytes) refuse('Output folder exceeds 20 MiB.');
      const bytes = await checkedFile(root, filePath);
      total += bytes.length;
      if (total > HOSTING_LIMITS.artifactBytes) refuse('Output folder exceeds 20 MiB.');
      inventory.push({ path: name, bytes: bytes.length, sha256: await sha256(bytes), mime });
    }
  }
  await walk(canonical);
  if (await realpath(selected) !== canonical) refuse('Output folder changed during inspection.');
  return { root, directory: canonical, artifact: await parseArtifact({ version: 1, entry: 'index.html', files: inventory }) };
}

export async function uploadProjectOutput(control, input, folder, { fetchImpl = fetch } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['directoryPath', 'clientRequestId'].includes(key))
    || !/^[A-Za-z0-9_-]{1,100}$/.test(input.clientRequestId ?? '')) refuse('Use the documented directoryPath and stable clientRequestId.');
  const active = () => {
    if (!control.runId || control.closed || control.fatal || control.requestSignal?.aborted || control.abort?.signal.aborted) refuse('This agent connection is unavailable.');
  };
  const call = async (path, body, raw = false) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      active();
      const response = await fetchImpl(`${control.url}/v2/hosting${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(30_000), control.requestSignal, control.abort?.signal].filter(Boolean)),
      headers: { authorization: `Bearer ${control.token}`, 'x-pilot-run': control.runId, 'Content-Type': raw ? 'application/octet-stream' : 'application/json' },
      ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
    });
      const value = JSON.parse(new TextDecoder().decode(await boundedBytes(response.body, HOSTING_LIMITS.manifestBytes + 16 * 1024)));
      if (response.status === 429 && attempt < 2) {
        const seconds = Number(response.headers.get('Retry-After'));
        await delay(Math.max(1000, Math.min(60000, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 10000)), undefined,
          { signal: AbortSignal.any([control.requestSignal, control.abort?.signal].filter(Boolean)) });
        continue;
      }
      if (!response.ok) refuse(value?.message ?? 'Hosting did not confirm this request. Retry the original files and request ID.');
      return value;
    }
  };
  return submitProjectOutput(input, folder, { call, active });
}

/** One upload protocol for worker-run and approved-computer MCP authority. */
export async function submitProjectOutput(input, folder, { call, active = () => {}, expectedArtifact } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['directoryPath','clientRequestId'].includes(key))
    || !/^[A-Za-z0-9_-]{1,100}$/.test(input.clientRequestId ?? '') || typeof call !== 'function'
    || expectedArtifact !== undefined && !/^[a-f0-9]{64}$/.test(expectedArtifact)) refuse('Use the documented output folder, digest and stable request ID.');
  active();
  const status = await call('');
  if (!status.configured || !status.policy?.enabled || !Number.isSafeInteger(status.policy.revision)) refuse('The project owner must configure and enable hosting first.');
  const build = await inspectProjectOutput(folder, input.directoryPath);
  if (expectedArtifact !== undefined && build.artifact.digest !== expectedArtifact) refuse('The selected build differs from the approved artifact. Inspect and approve its exact files before upload.');
  active();
  const candidate = await call('/candidates', { clientRequestId: input.clientRequestId, policyRevision: status.policy.revision, manifest: build.artifact.manifest });
  if (!/^[a-f0-9]{64}$/.test(candidate.candidateId)) refuse('Hosting did not return a verified candidate ID.');
  if (candidate.state !== 'ready') {
    const status = await call(`/candidates/${candidate.candidateId}/status`);
    if (status.digest !== build.artifact.digest || !Array.isArray(status.uploaded) || status.uploaded.length > HOSTING_LIMITS.files
      || status.uploaded.some(index => !Number.isSafeInteger(index) || index < 0 || index >= build.artifact.manifest.files.length)) refuse('Hosting did not return verified upload progress.');
    const uploaded = new Set(status.uploaded);
    for (const [index, file] of build.artifact.manifest.files.entries()) {
      if (uploaded.has(index)) continue;
      const bytes = await checkedFile(build.root, join(build.directory, ...file.path.split('/')), file);
      await call(`/candidates/${candidate.candidateId}/files/${index}`, bytes, true);
    }
    let ready = false;
    for (let batch = 0; batch <= Math.ceil(build.artifact.manifest.files.length / 32); batch++) {
      const sealed = await call(`/candidates/${candidate.candidateId}/seal`, {});
      if (sealed.state === 'ready') { ready = true; break; }
    }
    if (!ready) refuse('Validation remains pending. Retry the same files and request ID.');
  }
  if (status.policy.mode === 'automatic') {
    const result = await call('/publications', { clientRequestId: `${input.clientRequestId}-publish`, candidateId: candidate.candidateId, policyRevision: status.policy.revision });
    return { candidateId: candidate.candidateId, artifact: build.artifact.digest, state: result.state, operationId: result.id };
  }
  return { candidateId: candidate.candidateId, artifact: build.artifact.digest, state: 'awaiting_approval', message: 'A designated person can approve this exact build in Outputs. Nothing was published by this upload.' };
}
