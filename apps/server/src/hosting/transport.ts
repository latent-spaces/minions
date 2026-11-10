import { HOSTING_LIMITS, boundedBytes, parseHostingServingHead, type HostingServingHead } from '@mlswarm/contracts';
import { deploymentKind } from '../deployment.js';
import { Refusal } from '../errors.js';

export interface HostingTransport {
  command(projectId: string, path: string, body?: unknown, method?: 'GET' | 'POST'): Promise<Record<string, unknown>>;
  upload(projectId: string, candidateId: string, index: number, bytes: Buffer): Promise<void>;
}
/** Server-only credential. No cloud hostname/secret is accepted from request bodies. */
export function hostingTransport(): HostingTransport {
  const origin = process.env.HOSTING_CONTROL_ORIGIN, token = process.env.HOSTING_CONTROL_TOKEN;
  if (!origin || !token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Refusal('project_busy', 'Static hosting is not configured. No output was published.');
  const url = new URL(origin);
  // Only a disposable test session may reach a plain-HTTP loopback hosting control.
  const local = deploymentKind() === 'test' && url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port);
  if (url.origin !== origin || url.protocol !== 'https:' && !local || url.username || url.password) throw new Error('Invalid hosting control origin.');
  const send = async (projectId: string, path: string, body: string | Buffer | undefined, method: 'GET' | 'POST') => {
    if (!/^[a-f0-9]{64}$/.test(projectId) || !/^(?:prepare\/[a-f0-9]{64}|cleanup\/[a-f0-9]{64}|audit\/[a-f0-9]{64}|status\/[a-f0-9]{64}|upload\/[a-f0-9]{64}\/\d{1,4}|seal\/[a-f0-9]{64}|head)$/.test(path)) throw new Error('Invalid internal hosting path.');
    const response = await fetch(`${origin}/control/${projectId}/${path}`, { method, body: Buffer.isBuffer(body) ? new Uint8Array(body) : body, redirect: 'error',
      signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' } });
    const result = JSON.parse(new TextDecoder().decode(await boundedBytes(response.body, HOSTING_LIMITS.headBytes + 1024)));
    if (response.status === 429) throw new Refusal('rate_limited', 'Hosting is busy. Retry the same upload.', Math.min(60, Math.max(1, Number(response.headers.get('Retry-After')) || 1)));
    if (!response.ok) throw new Error(`Hosting control response ${response.status}.`);
    return result as Record<string, unknown>;
  };
  return {
    command: (projectId, path, body, method = 'POST') => send(projectId, path, body === undefined ? undefined : JSON.stringify(body), method),
    upload: async (projectId, candidateId, index, bytes) => { await send(projectId, `upload/${candidateId}/${index}`, bytes, 'POST'); },
  };
}

export function observedHead(value: unknown): HostingServingHead | null {
  if (value === null) return null;
  try { return parseHostingServingHead(value); }
  catch { throw new Error('Invalid hosting acknowledgement.'); }
}
