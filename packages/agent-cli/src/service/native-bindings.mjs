import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { devNull } from 'node:os';
import { hostToolEnvironment } from '../windows-command.mjs';
import { claimWorkerCheckout } from '../checkout-ownership.mjs';
import { ensureHome, physicalPath, pathInside, writePrivate, assertStateOutsideWorkspace } from '../state.mjs';
import { createLocalWorkerAdapter } from '../native-worker-adapter.mjs';
import { RuntimeError, sameTarget, validateTarget } from './contracts.mjs';
import { snapshotWorkerInstructions } from '../worker-guidance.mjs';
import { canonicalGithubRepo } from '../github-repository.mjs';

const overlap = (a, b) => pathInside(a, b) || pathInside(b, a);
export function checkoutGitEnvironment(env = process.env, platform = process.platform) {
  // Git for Windows accepts the DOS null device for a disabled global config;
  // Node's \\.\nul spelling is a device-namespace path, not a Git config path.
  return { ...hostToolEnvironment(env), LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: platform === 'win32' ? 'NUL' : devNull };
}
function repository(value) {
  if (typeof value !== 'string') throw new Error('A GitHub repository is required.');
  const canonical = canonicalGithubRepo(`https://github.com/${value.replace(/^(?:https:\/\/github\.com\/|git@github\.com:)/, '')}`);
  if (!canonical) throw new Error('A canonical GitHub repository is required.');
  return canonical.slice('https://github.com/'.length);
}
const runFile = promisify(execFile);
const git = async (folder, args, signal) => (await runFile('git', ['-C', folder, ...args], { signal, encoding: 'utf8', timeout: 3000, maxBuffer: 65536, windowsHide: true, env: checkoutGitEnvironment() })).stdout.trim();

// Trusted installation composition only. Public commands select an identity and
// approved provider/model; they cannot introduce a checkout, binary or credential.
export function createNativeAdapterFactory({ bindings, registryRoot, executables, envSource, adapterFactory = createLocalWorkerAdapter }) {
  if (!Array.isArray(bindings) || !bindings.length) throw new Error('Private native bindings are required.');
  const prepared = bindings.map(binding => {
    validateTarget(binding.target);
    if (typeof binding.prepareParticipation !== 'function' || typeof binding.readProjectState !== 'function' || typeof binding.createBridge !== 'function') throw new Error('A scoped bridge factory and participation reader are required.');
    const folder = physicalPath(binding.folder), stateDir = physicalPath(binding.stateDir);
    ensureHome(stateDir);
    assertStateOutsideWorkspace(stateDir, folder);
    repository(binding.repository);
    return { ...binding, target: structuredClone(binding.target), folder, stateDir };
  });
  for (let i = 0; i < prepared.length; i++) for (let j = i + 1; j < prepared.length; j++) {
    if (sameTarget(prepared[i].target, prepared[j].target) || overlap(prepared[i].folder, prepared[j].folder) || overlap(prepared[i].stateDir, prepared[j].stateDir)
      || overlap(prepared[i].folder, prepared[j].stateDir) || overlap(prepared[j].folder, prepared[i].stateDir)) throw new Error('Native bindings must have unique targets and separate working/state folders.');
  }
  return async (mission, { signal } = {}) => {
    signal?.throwIfAborted();
    const binding = prepared.find(item => sameTarget(item.target, mission.target));
    if (!binding) throw new RuntimeError('unknown_binding', 'This project agent has no trusted local binding.');
    // Revalidate before each mission, including origin edits after installation.
    // An empty folder (a control_agent start without a prepared checkout) gets its own reason, not controller_failed.
    const [root, origin] = await Promise.all([git(binding.folder, ['rev-parse', '--show-toplevel'], signal), git(binding.folder, ['remote', 'get-url', 'origin'], signal)]).catch(error => {
      if (signal?.aborted) throw error;
      throw new RuntimeError('checkout_missing', 'The agent folder is not a Git checkout of the project repository. Clone it there, or add the agent with add_project_agent, then start again.');
    });
    signal?.throwIfAborted();
    if (physicalPath(root) !== binding.folder || repository(origin) !== repository(binding.repository)) throw new RuntimeError('invalid_binding', 'The bound Git checkout changed.');
    const claim = await claimWorkerCheckout({ folder: binding.folder, agentId: mission.target.agentId, project: mission.target.projectId, ...(registryRoot ? { registryRoot } : {}) });
    let native, issued;
    try {
      signal?.throwIfAborted();
      const stateDir = join(binding.stateDir, `mission-${mission.missionId}-${mission.generation}`);
      ensureHome(stateDir);
      snapshotWorkerInstructions(binding.stateDir, stateDir);
      issued = await binding.createBridge(mission, { signal, stateDir });
      signal?.throwIfAborted();
      const bridgeUrl = new URL(issued.url);
      if (bridgeUrl.protocol !== 'http:' || bridgeUrl.hostname !== '127.0.0.1' || bridgeUrl.username || bridgeUrl.password || bridgeUrl.search || bridgeUrl.hash
        || !/^\/worker\/[a-f0-9]{32}\/mcp$/.test(bridgeUrl.pathname) || typeof issued.revoke !== 'function'
        || typeof issued.token !== 'string' || !issued.token.trim() || issued.token.length > 4096 || /[\r\n]/.test(issued.token)) throw new Error('A revocable scoped worker loopback bridge is required.');
      const bridge = { url: bridgeUrl.href, token: issued.token, headers: { Authorization: `Bearer ${issued.token}` } };
      // Mission identity changes scope and native-session identity. Never resume
      // a previous mission merely because its agent uses the same working folder.
      writePrivate(join(stateDir, 'mcp.json'), { mcpServers: { pilot: { type: 'http', url: bridge.url, headers: bridge.headers } } });
      native = await adapterFactory({ client: mission.execution.provider, model: mission.execution.model, folder: binding.folder,
        stateDir, bridge, journalIdentity: { target: mission.target, missionId: mission.missionId, generation: mission.generation, provider: mission.execution.provider, model: mission.execution.model }, scope: mission.scope, firstLaunchByAt: binding.initialLaunch?.missionId === mission.missionId ? binding.initialLaunch.deadlineAt : null, prepareParticipation: options => binding.prepareParticipation({ ...options, mission }), executables, envSource, signal });
      signal?.throwIfAborted();
    } catch (error) { try { await issued?.revoke?.(); } finally { claim.release(); } throw error; }
    let turnOpen = false, guardPid = null, cleanupOpen = false, released = false, missionHeld = false;
    const beginTurn = () => {
      if (turnOpen || cleanupOpen || released) throw new Error('Mission checkout cannot open a concurrent or released turn.');
      if (!missionHeld) claim.beginTurn();
      missionHeld = true; turnOpen = true; guardPid = null;
    };
    const endTurn = ({ releaseMission = false } = {}) => { claim.endTurn({ cleanupConfirmed: true, retainClaim: !releaseMission }); missionHeld = !releaseMission; turnOpen = false; guardPid = null; };
    return {
      deliveryState: () => issued.deliveryState?.() ?? { pending: 0, notices: [] },
      retryCoordination: options => issued.retryPending?.(options),
      acknowledgeNotices: notices => issued.acknowledgeNotices?.(notices),
      async observe({ signal } = {}) { return binding.readProjectState({ mission, signal }); },
      async run(options) {
        beginTurn();
        let measuring = false;
        // Missing telemetry must not change native execution or cleanup behavior.
        try { if (issued.beginContext) { await issued.beginContext(); measuring = true; } } catch {}
        let result, context;
        try { result = await native.run({ ...options,
          // A missing native session may retry inside native.run after the first
          // guard proves cleanup. Each attempt gets its own spawning boundary.
          onModelStarting: async () => { if (!turnOpen) beginTurn(); await options.onModelStarting?.(); },
          onGuardStarted: async pid => { guardPid = pid; claim.guardStarted(pid); await options.onGuardStarted?.(pid); },
          onModelStarted: async pid => { claim.nativeStarted(pid); await options.onModelStarted?.(pid); },
          onGuardClosed: async proof => {
            if (proof.cleanupConfirmed !== true || (guardPid !== null && proof.guardPid !== guardPid)) throw new Error('Worker checkout guard cleanup identity changed.');
            endTurn();
            await options.onGuardClosed?.(proof);
          },
        });
        } finally { if (measuring) { try { context = await issued.endContext?.(); } catch {} } }
        if (context && result.usage?.context) result.usage.context = { ...result.usage.context, ...context, scope: 'mlswarm-supplied', coverage: 'partial' };
        else if (result.usage) delete result.usage.context;
        // Also covers preparation failures and cancellation before any guard.
        if (result.cleanupConfirmed === true && turnOpen) endTurn();
        return result;
      },
      async release({ cleanupConfirmed }) {
        if (cleanupConfirmed !== true || released) return;
        // Keep a non-idle durable claim until both the native group and detached
        // mission processes are confirmed absent. A failed sweep/revoke must not
        // free the checkout, even if the service crashes before a retry.
        if (!cleanupOpen) { endTurn(); cleanupOpen = true; }
        await native.stopLeftovers();
        await issued?.revoke?.();
        endTurn({ releaseMission: true }); claim.release(); released = true;
      },
    };
  };
}
