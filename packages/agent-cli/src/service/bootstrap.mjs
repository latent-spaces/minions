import { createSteering } from './steering.mjs';
// Trusted installed composition. Public MCP inputs select identities, never
// credentials, binaries or arbitrary launch configuration.
import { join } from 'node:path';
import { createWebAgentStarts } from './web-agent-starts.mjs';
import { createGitHubAccessObserver } from './github-observations.mjs';
import { inspectWorkerCheckout } from '../checkout-ownership.mjs';
import { stopOrphanedMission } from './orphan-stop.mjs';
import { mkdirSync } from 'node:fs';
import { sessionHome } from '../session.mjs';
import { createOwnerClient } from '../owner-client.mjs';
import { createDiscovery } from '../discovery.mjs';
import { ensureHome, digest, writePrivate, connectionDir, readPrivate, lstatExists, assertStateOutsideWorkspace } from '../state.mjs';
import { verifyBundle } from '../system.mjs';
import { openRuntimeStore } from './store.mjs';
import { createCloudRuntime } from './cloud-runtime.mjs';
import { createCloudClient } from './cloud-client.mjs';
import { createWorkerOperations } from './worker-operations.mjs';
import { createWorkerBridgeFactory } from './worker-bridge.mjs';
import { createNativeAdapterFactory } from './native-bindings.mjs';
import { createRuntimeApplication } from './application.mjs';
import { validateTarget } from './contracts.mjs';
import { createRunEvidence } from './run-evidence.mjs';

export async function composeInstalledRuntime({ home, site, getService, credentialHome = sessionHome(), fetchImpl = fetch, webStartOptions = {} }) {
  const accountClient = createOwnerClient({ home: credentialHome, site, fetchImpl });
  const account = accountClient.currentAccount();
  if (account.status !== 'approved' || !account.account_profile_id) throw new Error('Run setup and finish computer approval before starting the service.');
  const principal = { site, ownerId: account.account_profile_id };
  validateTarget({ ...principal, projectId: 'installation', agentId: 'installation' });
  const registry = new Map();
  let runtime, store, webStarts, githubObservations, closed = false;
  const key = target => JSON.stringify([target.site,target.ownerId,target.projectId,target.agentId]);
  function install(record, token) {
    if (closed) throw new Error('The service is closing.');
    const url = new URL(record.service), projectId = url.pathname.split('/p/')[1];
    const target = validateTarget({ ...principal, projectId, agentId: record.agentId });
    if (record.ownerProfileId !== principal.ownerId || url.origin !== site || record.service !== `${site}/p/${projectId}`)
      throw new Error('Saved agent connection does not belong to this installation.');
    const identity = key(target), previous = registry.get(identity);
    if (previous) {
      if (previous.folder !== record.folder || previous.token !== token) throw new Error('A live binding changed. End its work and restart the service explicitly.');
      return previous;
    }
    assertStateOutsideWorkspace(home,record.folder);
    const stateDir = join(home, 'agents', digest(identity));
    ensureHome(stateDir);
    const bundle = verifyBundle();
    writePrivate(join(stateDir,'worker-guides.json'), bundle.files['worker-guides.json'].toString('utf8'));
    writePrivate(join(stateDir,'instructions.md'), bundle.files['AGENT_PROMPT_V2.md'].toString('utf8'));
    const intentFile = record.webStartId ? join(home,'web-starts',`${record.webStartId}.json`) : null;
    const intent = intentFile && lstatExists(intentFile) ? readPrivate(intentFile,true) : null;
    const initialLaunch = record.webStartId && intent?.request?.id === record.webStartId && Number.isSafeInteger(intent.request.launchByAt)
      ? { missionId:record.webStartId, deadlineAt:intent.request.launchByAt } : null;
    const binding = { target, url: record.service, token, folder: record.folder, stateDir, repository: record.repo, initialLaunch, fetchImpl };
    registry.set(identity,binding);
    try { runtime?.addBinding(binding); } catch (error) { registry.delete(identity); throw error; }
    return binding;
  }
  const resolveBinding = target => {
    validateTarget(target);
    if (target.site !== site || target.ownerId !== principal.ownerId) throw new Error('This target is outside the installation.');
    return registry.get(key(target));
  };
  try {
    for (const {record,token} of accountClient.localAgentConnections({expectedProfileId:principal.ownerId})) install(record,token);
    store = await openRuntimeStore({ directory:join(home,'ledger') });
    const workerOperations = createWorkerOperations({ store, resolveBinding: caller => resolveBinding(caller.target), fetchImpl });
    const bridges = createWorkerBridgeFactory({ getService, workerOperations });
    const adapterFactory = async (mission, options) => {
      const selected = resolveBinding(mission.target);
      if (!selected) throw new Error('This agent has no trusted local binding.');
      const bindings = [selected].map(binding => ({...binding,
        createBridge: bridges.createBridge,
        prepareParticipation: ({mission:active,signal,pauseUpdate}) => bridges.prepareParticipation({mission:active,signal,pauseUpdate}),
        readProjectState: ({mission:active,signal}) => createCloudClient(binding).observe(active,{signal}),
      }));
      const factory = createNativeAdapterFactory({ bindings });
      return factory(mission,options);
    };
    runtime = createCloudRuntime({ store, principal, cloudBindings:[], participationBindings:[...registry.values()],
      resolveBinding, fetchImpl, adapterFactory, ownerControlsClient:accountClient,
      inspectRecoveryCheckout:mission=>{const binding=resolveBinding(mission.target);return binding
        ? inspectWorkerCheckout({folder:binding.folder,agentId:mission.target.agentId,project:mission.target.projectId}):null;},
      stopOrphanedMission:mission=>{const binding=resolveBinding(mission.target);
        if(!binding)throw new Error('This project agent has no trusted local binding.');
        return stopOrphanedMission(mission,{folder:binding.folder});} });
    // Adds take the account's operation lock, which refuses rather than waits, so this service runs
    // them one at a time: two website starts in the same poll would otherwise fail each other.
    let adding = Promise.resolve();
    const ownerClient = { ...accountClient, addAgent(...args) {
      const turn = adding.then(async () => {
        const added = await accountClient.addAgent(...args);
        assertStateOutsideWorkspace(home,added.record.folder);
        mkdirSync(added.record.folder,{recursive:true});
        install(added.record, readPrivate(join(connectionDir(credentialHome,added.record.id),'token')));
        return added;
      });
      adding = turn.catch(() => {});
      return turn;
    } };
    webStarts = createWebAgentStarts({home,principal,ownerClient,controllers:runtime.controllers,addAgent:ownerClient.addAgent,...webStartOptions});
    githubObservations = createGitHubAccessObserver({ ownerClient, principal });
    const steering=createSteering({accountClient,principal,store});
    const application = createRuntimeApplication({ connectionStatus:()=>webStarts.status(), steering, controllers:runtime.controllers, principal, ownerClient,
      discovery:createDiscovery({site}), workerOperations, participation:runtime.participation,
      evidence:createRunEvidence({controllers:runtime.controllers,principal,resolveBinding,
        resolveJournalDirectory:mission=>join(home,'agents',digest(key(mission.target)),`mission-${mission.missionId}-${mission.generation}`)}) });
    return { application, principal, controllers:runtime.controllers,
      async close() { if (closed) return; closed=true; try { await Promise.all([webStarts?.close(), githubObservations?.close()]); await runtime.close(); } finally { await store.close(); } } };
  } catch (error) {
    closed = true;try { await Promise.all([webStarts?.close(), githubObservations?.close()]); await runtime?.close(); } finally { await store?.close(); }throw error;
  }
}
