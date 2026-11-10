import { HOSTING_LIMITS, type HostingArtifact, type HostingManifest, type HostingFile, type HostingServingHead } from './project-hosting.js';

const MIMES: Record<string, string> = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json', txt: 'text/plain; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', svg: 'image/svg+xml', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm',
  wasm: 'application/wasm',
};
export class HostingError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function reject(message: string): never { throw new HostingError(400, message); }
export const isDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function exactObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) reject('Invalid hosting record.');
  return value as Record<string, unknown>;
}
/** One portable, URL-safe spelling. Reject rather than silently renaming user files. */
export function artifactPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.normalize('NFC') !== value
    || new TextEncoder().encode(value).length > HOSTING_LIMITS.pathBytes
    || /[\\%?#:<>"|*\u0000-\u0020\u007f\p{C}]/u.test(value)) reject('Invalid artifact path.');
  const parts = value.split('/');
  if (parts.length > HOSTING_LIMITS.depth || parts.some(p => !p || p.startsWith('.') || /[. ]$/.test(p)
    || /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(p))) reject('Invalid artifact path.');
  return value;
}
export function artifactMime(path: string): string {
  const extension = path.split('.').at(-1)!.toLowerCase();
  return Object.hasOwn(MIMES, extension) ? MIMES[extension] : reject('Unsupported static file type.');
}
export async function sha256(bytes: Uint8Array | string): Promise<string> {
  const input = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(input)))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export async function parseArtifact(raw: unknown): Promise<HostingArtifact> {
  const value = exactObject(raw, ['version', 'entry', 'files']);
  if (value.version !== 1 || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > HOSTING_LIMITS.files) reject('Invalid manifest inventory.');
  const entry = artifactPath(value.entry);
  if (entry !== 'index.html') reject('V1 requires index.html at the artifact root.');
  const paths = new Set<string>();
  let bytes = 0;
  const files: HostingFile[] = value.files.map(rawFile => {
    const file = exactObject(rawFile, ['path', 'bytes', 'sha256', 'mime']);
    const path = artifactPath(file.path), collisionKey = path.toLowerCase();
    if (paths.has(collisionKey)) reject('Duplicate or case-ambiguous artifact path.');
    paths.add(collisionKey);
    if (typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > HOSTING_LIMITS.fileBytes
      || !isDigest(file.sha256) || file.mime !== artifactMime(path)) reject('Invalid file metadata.');
    bytes += file.bytes;
    return { path, bytes: file.bytes, sha256: file.sha256 as string, mime: file.mime as string };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const file of files) {
    const parts = file.path.toLowerCase().split('/'); parts.pop();
    while (parts.length) {
      if (paths.has(parts.join('/'))) reject('An artifact file cannot also be a directory.');
      parts.pop();
    }
  }
  if (bytes > HOSTING_LIMITS.artifactBytes || !files.some(file => file.path === entry && file.bytes > 0)) reject('Invalid artifact size or entry point.');
  const manifest: HostingManifest = { version: 1, entry, files };
  const canonical = JSON.stringify(manifest);
  if (new TextEncoder().encode(canonical).length > HOSTING_LIMITS.manifestBytes) reject('Manifest too large.');
  return { manifest, bytes, digest: await sha256(canonical) };
}

/** Bounded even when Content-Length is absent or dishonest. */
export async function boundedBytes(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new HostingError(413, 'Upload exceeds reserved size.'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export function parseHostingServingHead(raw: unknown): HostingServingHead {
  const head = exactObject(raw, ['version', 'revision', 'generation', 'operationId', 'intent', 'disabled', 'current', 'releases']);
  if (head.version !== 1 || !Number.isSafeInteger(head.revision) || Number(head.revision) < 1
    || !Number.isSafeInteger(head.generation) || Number(head.generation) < 1
    || !isDigest(head.operationId) || !isDigest(head.intent) || typeof head.disabled !== 'boolean'
    || head.current !== null && !isDigest(head.current) || !Array.isArray(head.releases)
    || head.releases.length > HOSTING_LIMITS.releaseReferences) reject('Invalid serving head.');
  let total = 0;
  const ids = new Set<string>();
  for (const rawRelease of head.releases) {
    const release = exactObject(rawRelease, ['artifact', 'buildId', 'bytes', 'retiredAt']);
    if (!isDigest(release.buildId) || release.retiredAt !== null && (!Number.isSafeInteger(release.retiredAt) || Number(release.retiredAt) < 0)
      || !isDigest(release.artifact) || ids.has(release.artifact) || !Number.isSafeInteger(release.bytes)
      || Number(release.bytes) < 1 || Number(release.bytes) > HOSTING_LIMITS.artifactBytes) reject('Invalid release.');
    ids.add(release.artifact); total += Number(release.bytes);
  }
  const current = (head.releases as HostingServingHead['releases']).filter(release => release.retiredAt === null);
  if (head.disabled ? current.length !== 0 : current.length !== 1 || current[0].artifact !== head.current) reject('Invalid current release.');
  if (total > HOSTING_LIMITS.retainedBytes || (head.disabled ? head.current !== null || ids.size !== 0 : !ids.has(String(head.current)))) reject('Invalid active release.');
  return head as HostingServingHead;
}
