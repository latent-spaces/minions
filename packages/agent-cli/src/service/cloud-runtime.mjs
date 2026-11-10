import { createCloudClient } from './cloud-client.mjs';
import { createReportDelivery } from './report-delivery.mjs';
import { createRuntimeControllers } from './controllers.mjs';
import { sameTarget, validateTarget } from './contracts.mjs';
import { createParticipationRuntime } from './participation-runtime.mjs';
import { createOwnerParticipationControls } from './owner-participation-controls.mjs';

// Trusted service composition. Connections/commands cannot install a cloud
// credential, pick a sender or create a background controller on reconnect.
export function createCloudRuntime({ store, adapterFactory, cloudBindings, participationBindings = [], ownerControlsClient, ownerControlIntervalMs, ownerControlTimeoutMs, observeIntervalMs, deliveryIntervalMs, participationSweepIntervalMs, inspectRecoveryCheckout, stopOrphanedMission, principal: configuredPrincipal, resolveBinding: trustedResolver, fetchImpl = fetch }) {
  if (!Array.isArray(cloudBindings)) throw new Error('Scoped cloud bindings are required.');
  const bindings = cloudBindings.map(binding => ({ target: structuredClone(validateTarget(binding.target)), client: createCloudClient(binding) }));
  for (let i = 0; i < bindings.length; i++) for (let j = i + 1; j < bindings.length; j++) if (sameTarget(bindings[i].target, bindings[j].target)) throw new Error('Cloud bindings must have distinct targets.');
  if (!Array.isArray(participationBindings)) throw new Error('Participation bindings must be a trusted array.');
  const chats = participationBindings.map(binding => ({ ...binding, target: structuredClone(validateTarget(binding.target)) }));
  if (!bindings.length && !chats.length && !configuredPrincipal) throw new Error('At least one trusted project binding or fixed installation principal is required.');
  const principal = validateTarget({ ...(configuredPrincipal ?? (bindings[0] ?? chats[0]).target), projectId:'identity', agentId:'identity' });
  if ([...bindings,...chats].some(item => item.target.site !== principal.site || item.target.ownerId !== principal.ownerId)) throw new Error('One shared runtime must have one site and owner.');
  if (ownerControlsClient && !chats.length && typeof trustedResolver !== 'function') throw new Error('Owner participation controls require configured chat targets or a trusted resolver.');
  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i];
    if (chats.some((other, index) => index !== i && sameTarget(other.target, chat.target))) throw new Error('Participation bindings must have distinct targets.');
    if (bindings.some(other => other.target.site !== chat.target.site || other.target.ownerId !== chat.target.ownerId)) throw new Error('One shared runtime must have one site and owner.');
    const existing = cloudBindings.find(other => sameTarget(other.target, chat.target));
    if (existing && (existing.url !== chat.url || existing.token !== chat.token)) throw new Error('Shared target credentials must match across execution modes.');
    if (!existing) bindings.push({ target: chat.target, client: createCloudClient(chat) });
  }
  const resolve = async target => {
    let binding = bindings.find(item => sameTarget(item.target, target));
    if (!binding && trustedResolver) { const found = await trustedResolver(target); if (found) { addBinding(found); binding = bindings.find(item => sameTarget(item.target,target)); } }
    if (!binding) throw Object.assign(new Error('Original cloud target has no configured credential; evidence is retained.'), { code: 'unbound_report_target', fatal: true });
    return binding.client;
  };
  const delivery = createReportDelivery({ store, send: async (entry, options) => (await resolve(entry.target)).send(entry, options), ...(deliveryIntervalMs === undefined ? {} : { intervalMs: deliveryIntervalMs }) });
  const controllers = createRuntimeControllers({ store, adapterFactory, inspectRecoveryCheckout, stopOrphanedMission, cloudFactory: mission => resolve(mission.target), onReportsReady: () => delivery.drain(), ...(observeIntervalMs === undefined ? {} : { observeIntervalMs }) });
  const participation = chats.length || trustedResolver ? createParticipationRuntime({ store, principal: { site: principal.site, ownerId: principal.ownerId },
    resolveBinding: async target => {
      let binding = chats.find(item => sameTarget(item.target, target));
      if (!binding && trustedResolver) { const found = await trustedResolver(target); if (found) { addBinding(found); binding = chats.find(item=>sameTarget(item.target,target)); } }
      if (!binding) throw new Error('This current-chat target has no trusted local binding.');
      return binding;
    },
    // A trusted test/composition binding may provide the same transport used by
    // its cloud client. Callers never supply credentials or transport functions.
    fetchImpl: (url, options) => {
      const binding = chats.find(item => url.startsWith(`${item.url}/v2/`));
      if (!binding && !trustedResolver) throw new Error('Participation transport target is not configured.');
      return (binding?.fetchImpl ?? fetchImpl)(url, options);
    }, onReportsReady: () => delivery.drain(), ...(participationSweepIntervalMs === undefined ? {} : { sweepIntervalMs: participationSweepIntervalMs }),
  }) : undefined;
  const ownerControls = ownerControlsClient ? createOwnerParticipationControls({ store, participation, controllers, ownerClient: ownerControlsClient,
    principal: { site: principal.site, ownerId: principal.ownerId }, targets: () => chats.map(item => item.target),
    ...(ownerControlIntervalMs === undefined ? {} : { intervalMs: ownerControlIntervalMs }),
    ...(ownerControlTimeoutMs === undefined ? {} : { timeoutMs: ownerControlTimeoutMs }),
  }) : undefined;
  // Drain saved evidence immediately on service construction. No native adapter
  // or cloud registration is involved in this replay, even after a crash.
  void delivery.drain().catch(() => {});
  function addBinding(binding) {
    const target = validateTarget(binding.target);
    if (target.site !== principal.site || target.ownerId !== principal.ownerId) throw new Error('Binding is outside this installation owner.');
    const old = chats.find(item=>sameTarget(item.target,target));
    if (old) { if (old.url!==binding.url || old.token!==binding.token || old.folder!==binding.folder || old.stateDir!==binding.stateDir) throw new Error('An installed binding cannot change during service operation.'); return; }
    const client = createCloudClient(binding);
    const cloud = bindings.find(item=>sameTarget(item.target,target));
    if (!cloud) bindings.push({target:structuredClone(target),client});
    chats.push({...binding,target:structuredClone(target)});
  }
  let closing;
  return { controllers, addBinding, participation, delivery, ownerControls, close() { return closing ??= (async () => { try { await ownerControls?.close(); await participation?.close(); await controllers.close(); await delivery.drain(); } finally { await delivery.close(); } })(); } };
}
