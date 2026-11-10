import { randomUUID } from 'node:crypto';
import { sameTarget, validateTarget, validateUuid } from './contracts.mjs';
import { validTokenLimit } from './token-cap.mjs';

// Trusted composition supplies a credential for this exact owner/project/agent.
// Durable report rows never contain credentials or request-selected endpoints.
export function createCloudClient({ target, url, token, fetchImpl = fetch, timeoutMs = 30000 }) {
  const identity = structuredClone(validateTarget(target));
  const expected = new URL(`/p/${encodeURIComponent(identity.projectId)}`, identity.site).href;
  if (url !== expected || typeof token !== 'string' || !token.trim() || token.length > 4096 || /[\r\n]/.test(token)
    || typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new Error('A scoped project endpoint, private credential and bounded request timeout are required.');
  const statuses = new Map();
  const failure = (code, fatal = false, retryAfter = 1) => Object.assign(new Error('Cloud runtime request could not be confirmed.'), { code, fatal, retryAfter });
  const assertMission = mission => {
    if (!sameTarget(identity, mission.target)) throw failure('forbidden', true);
    validateUuid(mission.missionId, 'missionId');
    if (mission.cloudRun && mission.cloudRun.runId !== mission.missionId) throw failure('runtime_conflict', true);
  };
  async function request(path, body, signal) {
    let response, value;
    try {
      response = await fetchImpl(`${url}/v2${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), redirect: 'error' });
      let text = '', size = 0;
      if (response.body) {
        const decoder = new TextDecoder();
        for await (const chunk of response.body) { size += chunk.byteLength; if (size > 128 * 1024) throw failure('invalid_reply'); text += decoder.decode(chunk, { stream: true }); }
        text += decoder.decode();
      } else text = await response.text();
      value = JSON.parse(text);
    } catch (error) {
      if (error?.code === 'invalid_reply') throw error;
      if (response) throw failure('invalid_reply', response.status >= 400 && response.status < 500 && response.status !== 429, retryAfter(response));
      throw failure(signal?.aborted ? 'cancelled' : 'unavailable');
    }
    const fatal = response.status >= 400 && response.status < 500 && response.status !== 429;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('invalid_reply', fatal, retryAfter(response));
    if (!response.ok) throw failure(typeof value.error === 'string' && /^[a-z_]{1,80}$/.test(value.error) ? value.error : 'http_failure', fatal, retryAfter(response, value));
    return value;
  }
  const checkPhase = (receipt, runId, phase) => {
    if (receipt.ok !== true || receipt.run_id !== runId || receipt.phase !== phase) throw failure('invalid_receipt');
    return receipt;
  };
  return {
    async start(mission, { signal } = {}) {
      assertMission(mission);
      const receipt = await request('/runs', { client_run_id: mission.missionId, runner_version: 'mlswarm-runtime-v2' }, signal);
      if (receipt.protocol !== 2 || receipt.run_id !== mission.missionId || !Number.isSafeInteger(receipt.generation) || receipt.generation < 1
        || !Number.isSafeInteger(receipt.poll_seconds) || receipt.poll_seconds < 1 || receipt.poll_seconds > 3600) throw failure('invalid_receipt');
      return { runId: receipt.run_id, cloudGeneration: receipt.generation, pollSeconds: receipt.poll_seconds };
    },
    async observe(mission, { signal } = {}) {
      assertMission(mission);
      const value = await request('/wait', { run_id: mission.missionId }, signal);
      if (!value.project || !['started','paused','closed'].every(key => typeof value.project[key] === 'boolean')
        || !Number.isSafeInteger(value.pending) || value.pending < 0 || !Number.isSafeInteger(value.acknowledged) || value.acknowledged < 0) throw failure('invalid_reply');
      return value;
    },
    async projectControl(mission, { afterRevision, signal } = {}) {
      assertMission(mission);
      const value = await request('/project-control', { run_id: mission.missionId,
        ...(afterRevision === undefined ? {} : { after_revision: afterRevision }) }, signal);
      const project = value.project;
      if (!project || !['started','paused','closed'].every(key => typeof project[key] === 'boolean')
        || !Number.isSafeInteger(project.revision) || project.revision < 0
        || project.pauseRequest && (!Number.isSafeInteger(project.pauseRequest.revision) || project.pauseRequest.revision < 1
          || project.pauseRequest.revision > project.revision || !Number.isSafeInteger(project.pauseRequest.requestedAt) || project.pauseRequest.requestedAt < 0))
        throw failure('invalid_reply');
      return project;
    },
    async phase(mission, phase, { signal } = {}) {
      assertMission(mission);
      if (!['idle','turn','backoff','paused','stopping'].includes(phase)) throw failure('bad_input', true);
      return checkPhase(await request(`/runs/${mission.missionId}/phase`, { phase }, signal), mission.missionId, phase);
    },
    async workerSession(mission, session, { signal } = {}) {
      assertMission(mission);
      if (!session || session.missionId !== mission.missionId || session.run_id !== undefined && session.run_id !== mission.missionId) throw failure('bad_input', true);
      const value = await request('/worker-session', { ...session, run_id: mission.missionId }, signal);
      if (value.missionId !== mission.missionId || !Array.isArray(value.messages) || value.messages.length > 64
        || value.tokenLimit !== undefined && !validTokenLimit(value.tokenLimit)) throw failure('invalid_reply');
      for (const message of value.messages) {
        try { validateUuid(message.id, 'steeringId'); if(message.threadId!==undefined && !/^[\w-]{1,200}$/.test(message.threadId))throw Error('Invalid steering thread'); } catch { throw failure('invalid_reply'); }
        if (message.missionId !== mission.missionId || message.generation !== mission.generation || typeof message.body !== 'string' || !message.body.trim() || Buffer.byteLength(message.body) > 16000) throw failure('invalid_reply');
      }
      return value;
    },
    async send(entry, { signal } = {}) {
      if (!sameTarget(identity, entry.target) || entry.runId !== entry.missionId) throw failure('forbidden', true);
      validateUuid(entry.runId, 'runId');
      if (entry.kind === 'steering_receipt') { const reply=await request('/steering-receipts',entry.payload,signal); if(reply.receiptId!==entry.expectedReceiptId)throw failure('invalid_receipt');return reply; }
      if (entry.kind === 'turn_report') {
        if (entry.payload?.run_id !== entry.runId) throw failure('bad_input', true);
        const receipt = await request('/turn-reports', entry.payload, signal);
        if (receipt.ok !== true || receipt.report_id !== entry.expectedReceiptId) throw failure('invalid_receipt');
        return { receiptId: receipt.report_id };
      }
      if (entry.kind !== 'stop_run' || entry.payload?.phase !== 'stopping' || entry.payload.worker_session && (entry.payload.worker_session.run_id !== entry.runId || entry.payload.worker_session.missionId !== entry.missionId)) throw failure('bad_input', true);
      checkPhase(await request(`/runs/${entry.runId}/phase`, entry.payload, signal), entry.runId, 'stopping');
      return { receiptId: entry.expectedReceiptId };
    },
    async reportStatus(mission, status, { signal } = {}) {
      assertMission(mission);
      if (typeof status !== 'string' || !status.trim() || [...status].length > 180 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(status)) throw failure('bad_input', true);
      let pending = statuses.get(mission.missionId);
      if (!pending || pending.status !== status) {
        pending = { run_id: mission.missionId, status, sequence: (pending?.sequence ?? 0) + 1, client_request_id: randomUUID() };
        statuses.set(mission.missionId, pending);
      }
      const receipt = await request('/status', pending, signal);
      if ((!receipt.superseded && receipt.focus?.text !== status) || !Number.isSafeInteger(receipt.focus?.updatedAt)) throw failure('invalid_receipt');
      return receipt;
    },
  };
}
function retryAfter(response, value) {
  const raw = value?.retry_after_seconds ?? response.headers.get('retry-after');
  const numeric = Number(raw);
  const seconds = Number.isFinite(numeric) ? numeric : (Date.parse(String(raw)) - Date.now()) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.min(3600, Math.ceil(seconds))) : 1;
}
