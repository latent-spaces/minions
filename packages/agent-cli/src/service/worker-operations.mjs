import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod/v4';
import { ProjectOperations } from '../../runtime/project-operations.mjs';
import { PROJECT_IMAGE_TOOL } from '../project-image.mjs';
import { PROJECT_OUTPUT_TOOL } from '../project-output.mjs';
import { verifyBundle } from '../system.mjs';
import { ensureHome, physicalPath, assertStateOutsideWorkspace, digest } from '../state.mjs';
import { RuntimeError, sameTarget, validateTarget, validateUuid, validateGeneration } from './contracts.mjs';
import { projectToolResult } from './project-tool-result.mjs';
import { readWorkerGuidance, WORKER_GUIDE_TOOL } from '../worker-guidance.mjs';

const failure = (code, message) => { throw new RuntimeError(code, message); };
const resultValue = reply => {
  if (reply?.error || reply?.result?.isError) failure('project_unavailable', 'The project operation was not confirmed.');
  try { return JSON.parse(reply.result.content.find(item => item.type === 'text').text); }
  catch { failure('invalid_reply', 'Project context could not be verified.'); }
};
export function createWorkerOperations({ store, resolveBinding, fetchImpl = fetch }) {
  if (!store || typeof resolveBinding !== 'function') throw new TypeError('A store and trusted worker binding resolver are required.');
  const generated = JSON.parse(verifyBundle().files['project-tools.json'].toString('utf8')).tools;
  const catalog = [...generated, PROJECT_IMAGE_TOOL, PROJECT_OUTPUT_TOOL, WORKER_GUIDE_TOOL].map(tool => ({ ...structuredClone(tool), inputSchema: { type: 'object', properties: {}, ...structuredClone(tool.inputSchema ?? {}), additionalProperties: false } }));
  const schemas = new Map(catalog.map(tool => [tool.name, z.fromJSONSchema(tool.inputSchema)]));
  const contexts = new Map();
  const keyFor = caller => {
    if (caller?.kind !== 'worker') failure('forbidden', 'A scoped worker caller is required.');
    validateTarget(caller.target); validateUuid(caller.missionId, 'missionId'); validateGeneration(caller.generation);
    return JSON.stringify([caller.target.site, caller.target.ownerId, caller.target.projectId, caller.target.agentId, caller.missionId, caller.generation]);
  };
  async function missionFor(caller, active = true) {
    keyFor(caller);
    const mission = await store.getMission({ target: caller.target, missionId: caller.missionId });
    if (!mission || !sameTarget(mission.target, caller.target) || mission.generation !== caller.generation || ['stopping','stopped','failed','recovery_required'].includes(mission.state)
      || active && (mission.state !== 'running' || !mission.currentTurnId)) failure('worker_inactive', 'This worker capability has no active matching mission turn.');
    return mission;
  }
  async function contextFor(caller) {
    const key = keyFor(caller);
    let pending = contexts.get(key);
    if (!pending) {
      pending = Promise.resolve().then(async () => {
        await missionFor(caller);
        const binding = await resolveBinding(caller);
        const expected = new URL(`/p/${encodeURIComponent(caller.target.projectId)}`, caller.target.site).href;
        if (!binding || binding.url !== expected || typeof binding.token !== 'string' || !binding.token.trim() || /[\r\n]/.test(binding.token)) failure('invalid_binding', 'The worker has no exact trusted project binding.');
        const stateDir = physicalPath(binding.stateDir), folder = physicalPath(binding.folder);
        ensureHome(stateDir); assertStateOutsideWorkspace(stateDir, folder);
        const control = { url: binding.url, token: binding.token, runId: caller.missionId, closed: false, fatal: null, abort: new AbortController(), news: null, pollSeconds: 20 };
        const bridge = new ProjectOperations(control, join(stateDir, `sends-${digest(JSON.stringify([caller.missionId, caller.generation]))}.json`), { folder, fetchImpl, verifyProject: value => verifyIdentity(caller, value) });
        return { control, bridge, stateDir, verifiedTurn: null, lane: Promise.resolve() };
      }).catch(error => { contexts.delete(key); throw error; });
      contexts.set(key, pending);
    }
    return pending;
  }
  function verifyIdentity(caller, value) {
    const identity = value?.you?.participation?.identity;
    if (value?.you?.agentId !== caller.target.agentId || identity?.projectId !== caller.target.projectId || identity?.agentId !== caller.target.agentId || identity?.profileId !== caller.target.ownerId)
      failure('identity_mismatch', 'The project replied with a different participant identity.');
  }
  async function serialized(caller, task, { signal } = {}) {
    const context = await contextFor(caller);
    const run = context.lane.then(async () => {
      signal?.throwIfAborted();
      const mission = await missionFor(caller);
      if (context.control.closed) failure('worker_inactive', 'The worker capability was released.');
      context.control.requestSignal = signal;
      try { return await task(context, mission); }
      finally { context.control.requestSignal = undefined; }
    });
    context.lane = run.catch(() => {});
    return run;
  }
  async function retryPending(caller, { signal } = {}) {
    const pending = contexts.get(keyFor(caller));
    if (!pending) return;
    const context = await pending;
    const run = context.lane.then(async () => {
      signal?.throwIfAborted();
      await missionFor(caller, false);
      if (context.control.closed || !context.verifiedTurn) return;
      context.control.requestSignal = signal;
      try { await context.bridge.retryDue(); } finally { context.control.requestSignal = undefined; }
    });
    context.lane = run.catch(() => {});
    return run;
  }
  return {
    retryPending,
    async beginContext(caller) {
      return serialized(caller, (context, mission) => {
        context.bridge.beginContext();
        context.contextTurn = mission.currentTurnId;
      });
    },
    async endContext(caller) {
      const pending = contexts.get(keyFor(caller));
      if (!pending) return null;
      const context = await pending;
      if (!context.contextTurn) return null;
      context.contextTurn = null;
      // Do not await in-flight remote replies: closing the counter fences them out.
      return context.bridge.endContext();
    },
    async listTools(caller, { measure = true } = {}) {
      // Use current server discovery, constrained to the strict bundled schemas.
      // An unavailable catalog never falls back to the full writable superset.
      return serialized(caller, async (context, mission) => {
        const measurement = measure && context.contextTurn === mission.currentTurnId ? context.bridge.context : null;
        const reply = await context.bridge.call({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/list', params: {} });
        if (reply?.error || !Array.isArray(reply?.result?.tools))
          failure('project_unavailable', 'Current project tools could not be verified.');
        const available = new Set(reply.result.tools.map(tool => tool.name));
        const tools = structuredClone(catalog.filter(tool => tool.name === WORKER_GUIDE_TOOL.name || available.has(tool.name)));
        context.bridge.recordContext(measurement, { method: 'tools/list' }, { result: { tools } });
        return tools;
      });
    },
    async callTool(caller, name, args = {}, options = {}) {
      keyFor(caller);
      const schema = schemas.get(name);
      if (!schema) failure('unknown_tool', 'This worker cannot use that operation.');
      let input;
      try { input = schema.parse(args); } catch { failure('bad_input', 'Use only the documented project arguments.'); }
      return serialized(caller, async (context, mission) => {
        if (name !== 'get_project' && context.verifiedTurn !== mission.currentTurnId) failure('identity_unverified', 'Call get_project and verify this worker identity first.');
        const measurement = context.contextTurn === mission.currentTurnId ? context.bridge.context : null;
        const measured = result => { context.bridge.recordContext(measurement, { method: 'tools/call', params: { name, arguments: input } }, { result }); return result; };
        if (name === WORKER_GUIDE_TOOL.name) {
          let guides;
          try { guides = readWorkerGuidance(join(context.stateDir, `mission-${caller.missionId}-${caller.generation}`)); }
          catch { failure('guide_unavailable', 'This mission workflow snapshot could not be verified. Preserve its saved work and report the blocker.'); }
          if (!guides) failure('guide_unavailable', 'This earlier mission has no workflow snapshot. Keep its original instructions; do not substitute the current package guide.');
          return measured({ content: [{ type: 'text', text: `MyLittleSwarm background-agent workflow (guide ${guides.guide_revision}, snapshot ${guides.sha256}). Apply only background-agent paths; owner/in-chat management is unavailable.\n\n${guides.sections[input.section]}` }] });
        }
        // A failed refresh may throw inside the prepared persona snapshot before
        // returning a reply. Revoke prior verification before that boundary.
        if (name === 'get_project') context.verifiedTurn = null;
        const reply = await context.bridge.call({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: input } });
        if (name === 'get_project') {
          const value = resultValue(reply); verifyIdentity(caller, value);
          context.control.news = { project: { started: value.project?.started === true, paused: value.project?.paused === true, closed: value.project?.completedAt != null } };
          context.verifiedTurn = mission.currentTurnId;
        }
        return measured(projectToolResult(reply, context.control.token));
      }, options);
    },
    async prepareParticipation(caller, options = {}) {
      return serialized(caller, async (context, mission) => {
        context.verifiedTurn = null;
        const snapshot = await context.bridge.beginParticipationTurn();
        if (snapshot.identity?.projectId !== caller.target.projectId || snapshot.identity?.agentId !== caller.target.agentId || snapshot.identity?.profileId !== caller.target.ownerId)
          failure('identity_mismatch', 'The project replied with a different participant identity.');
        context.control.news = { project: { started: true, paused: false, closed: false } };
        context.verifiedTurn = mission.currentTurnId;
        return snapshot;
      }, options);
    },
    async deliveryState(caller) {
      await missionFor(caller, false);
      const pending = contexts.get(keyFor(caller));
      if (!pending) return { pending: 0, notices: [] };
      const context = await pending;
      return { pending: context.bridge.journal.data.pending.length, notices: context.bridge.journal.notices() };
    },
    async acknowledgeNotices(caller, snapshot) {
      await missionFor(caller, false);
      if (!Array.isArray(snapshot) || snapshot.length > 128) failure('bad_input', 'Use the exact observed delivery notices.');
      const pending = contexts.get(keyFor(caller));
      if (!pending) return;
      const context = await pending;
      const run = context.lane.then(async () => {
        await missionFor(caller, false);
        const current = new Set(context.bridge.journal.notices().map(item => JSON.stringify(item)));
        if (snapshot.some(item => !current.has(JSON.stringify(item)))) failure('bad_input', 'Delivery notice snapshot does not match this mission.');
        context.bridge.journal.acknowledge(snapshot);
      });
      context.lane = run.catch(() => {});
      return run;
    },
    async release(caller) {
      const key = keyFor(caller), pending = contexts.get(key);
      if (!pending) return;
      const context = await pending;
      context.control.closed = true; context.control.abort.abort();
      await context.bridge.close(); await context.lane;
      contexts.delete(key);
      // The mission's private send journal remains pinned; release is not deletion.
    },
  };
}
