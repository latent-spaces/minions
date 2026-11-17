// Computer-authorized delivery is independent of agent participation. This pump
// transports explicit saved grants; it never creates work, credentials or models.
import { createOwnerBackgroundControls } from './owner-background-controls.mjs';
import { RuntimeError, sameTarget, validateTarget, validateUuid } from './contracts.mjs';
import { participationFingerprint, validateParticipationCommand } from './participation-contracts.mjs';
import { createConfirmedSnapshots } from './owner-snapshot-refresh.mjs';

const terminalCodes = new Set(['invalid_command','forbidden','conflict','invalid_binding','participation_inactive','participation_detached',
  'run_superseded','runtime_conflict','bad_input','unauthorized','not_found','run_active']);
const safeFailure = 'This saved control could not be applied. Inspect the current participation before approving another action.';
function bounded(action, signal, timeoutMs) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  return new Promise((resolve, reject) => {
    const cancelled = () => { cleanup(); reject(new RuntimeError('delivery_unavailable', 'Computer control delivery is unavailable. The original command is retained.')); };
    const cleanup = () => deadline.removeEventListener('abort', cancelled);
    deadline.addEventListener('abort', cancelled, { once: true });
    if (deadline.aborted) return cancelled();
    Promise.resolve().then(() => action(deadline)).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export function createOwnerParticipationControls({ store, participation, ownerClient, principal, targets, controllers, intervalMs = 15000, timeoutMs = 15000, refreshMs = 40000, now = Date.now }) {
  const owner = validateTarget({ ...principal, projectId: 'owner-controls', agentId: 'owner-controls' });
  if (!(Array.isArray(targets) || typeof targets === 'function') || typeof store?.latestParticipationsForTargets !== 'function'
    || typeof participation?.command !== 'function' || ['syncParticipations','listParticipationControls','acceptParticipationControl','acknowledgeParticipationControl'].some(name => typeof ownerClient?.[name] !== 'function')
    || ownerClient.origin !== undefined && ownerClient.origin !== owner.site
    || !Number.isSafeInteger(intervalMs) || intervalMs < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw new TypeError('Bounded owner delivery requires trusted participation targets and ports.');
  const currentBindings = () => {
    const values = typeof targets === 'function' ? targets() : targets;
    if (!Array.isArray(values)) throw new TypeError('Owner delivery targets must be an array.');
    const bindings = values.map(target => structuredClone(validateTarget(target)));
    if (bindings.some((target, index) => target.site !== owner.site || target.ownerId !== owner.ownerId || bindings.some((other,j)=>j!==index&&sameTarget(target,other)))) throw new TypeError('Owner delivery targets must be distinct and belong to its fixed owner and site.');
    return bindings;
  };
  currentBindings();
  const abort = new AbortController(), pending = new Map();
  let closed = false, polling;
  const call = action => bounded(action, abort.signal, timeoutMs);
  const confirmed = createConfirmedSnapshots({ refreshMs, now });
  const background=controllers?createOwnerBackgroundControls({store,controllers,ownerClient,owner,targets:currentBindings,call,refreshMs,now}):null;
  async function publish(chosen, required = false) {
    // Only the periodic full sync may skip confirmed pages; receipt proof always sends.
    const periodic = chosen === undefined, selected = chosen ?? currentBindings();
    if (periodic) confirmed.retain(selected);
    let failure;
    // Saved bindings are not active workers. Keep transport/store requests bounded
    // without limiting how many agents an idle installation can remember.
    for (let offset = 0; offset < Math.max(selected.length, 1); offset += 32) {
      try {
        const batch = selected.slice(offset, offset + 32);
        const rows = await call(() => store.latestParticipationsForTargets({ targets: batch }));
        if (!Array.isArray(rows) || rows.length > batch.length || required && rows.length !== batch.length) throw new RuntimeError('invalid_snapshot', 'Local participation snapshots are unavailable.');
        const participations = rows.map(record => {
          if (!batch.some(target => sameTarget(target, record?.target))) throw new RuntimeError('forbidden', 'Local participation target is outside this computer binding.');
          // Whitelist fields: tool references, paths, tokens and arbitrary metadata
          // remain private even if a trusted port supplies additional properties.
          const { target, participationId, generation, state, scope, approvedAt, deadlineAt, cloudRun } = record;
          return { target: structuredClone(target), participationId, generation, state, scope, approvedAt, deadlineAt,
            cloudRun: cloudRun ? { runId: cloudRun.runId, generation: cloudRun.generation, deadlineAt: cloudRun.deadlineAt } : null };
        });
        if (!participations.length) continue; // An empty page changes no cloud state.
        if (periodic && confirmed.fresh(participations)) continue;
        const sentAt = now();
        const receipt = await call(signal => ownerClient.syncParticipations({ participations }, { signal, expectedProfileId: owner.ownerId }));
        if (receipt?.ok !== true) throw new RuntimeError('invalid_receipt', 'The computer snapshot was not confirmed.');
        confirmed.confirm(participations, sentAt);
      } catch (error) {
        // Retain failure for retry, while unrelated pages still publish.
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }
  async function finish(item) {
    if (item.finishing || item.retired || !item.receipt || closed) return;
    item.finishing = true;
    try {
      // Applied is authority-bearing and needs this exact target's confirmed
      // snapshot. An unrelated project's refusal cannot block its acknowledgement.
      // Failed/expired receipts claim no authority; missing or rejected snapshots
      // must not keep a permanently refused operation queued forever.
      if (item.receipt.state === 'applied') await publish([item.target], true);
      else if (item.receipt.state === 'expired' && item.target) await publish([item.target]).catch(() => {});
      const ack = await call(signal => ownerClient.acknowledgeParticipationControl(item.id, item.receipt, { signal, expectedProfileId: owner.ownerId }));
      if (ack?.ok !== true) throw new RuntimeError('invalid_receipt', 'The saved control receipt was not confirmed.');
      pending.delete(item.id);
    } catch { /* Retry the exact immutable receipt; never fabricate another grant. */ }
    finally { item.finishing = false; }
  }
  function dispatch(envelope) {
    const bindings = currentBindings();
    let command, fingerprint;
    try {
      validateUuid(envelope?.id, 'controlId');
      command = validateParticipationCommand(envelope.command);
      if (command.operationId !== envelope.id || !['extend','release','wake'].includes(command.kind)
        || !bindings.some(target => sameTarget(target, command.target))) throw new RuntimeError('forbidden', 'This control is not for a configured local participation.');
      fingerprint = participationFingerprint(command);
    } catch {
      if (typeof envelope?.id !== 'string') return;
      try { validateUuid(envelope.id, 'controlId'); } catch { return; }
      if (pending.has(envelope.id) || pending.size >= 32) return;
      const item = { id: envelope.id, receipt: { state: 'failed', message: safeFailure } };
      pending.set(item.id, item); void finish(item); return;
    }
    const known = pending.get(envelope.id);
    if (known) { if (known.fingerprint === fingerprint) void finish(known); return; }
    if (pending.size >= 32) return;
    const item = { id: envelope.id, target: structuredClone(command.target), fingerprint, receipt: null, finishing: false };
    pending.set(item.id, item);
    // Do not serialize network commands in this transport. The coordinator owns
    // per-target ordering and allows validated End to bypass a stalled extension.
    item.task = (async () => {
      if (command.kind === 'wake') {
        const accepted = await call(signal => ownerClient.acceptParticipationControl(item.id, { signal, expectedProfileId: owner.ownerId }));
        if (!accepted || !['queued','accepted','cancelled','applied','expired','failed'].includes(accepted.state))
          throw new RuntimeError('invalid_reply', 'Wake acceptance was not confirmed.');
        if (accepted.state !== 'accepted') return; // Cancellation/terminal receipt wins; do not create local intent.
      }
      return call(() => participation.command(command));
    })().then(result => {
      if (!result) return;
      const record = result?.participation;
      if (!record || !sameTarget(record.target, command.target)) throw new RuntimeError('invalid_reply', 'The local participation result was not confirmed.');
      if (record.state === 'recovery_required') item.receipt = { state: 'failed', message: safeFailure };
      else if (command.kind !== 'release' && (record.state === 'expired' || record.deadlineAt <= Date.now())) item.receipt = { state: 'expired' };
      else if (command.kind === 'release' ? ['released','expired'].includes(record.state) : record.state === 'active' && record.cloudRun?.deadlineAt === record.deadlineAt && Number.isSafeInteger(record.cloudRun?.generation)) item.receipt = { state: 'applied' };
      else if (record.state === 'released') item.receipt = { state: 'failed', message: safeFailure };
    }).catch(error => {
      if (terminalCodes.has(error?.code)) item.receipt = { state: 'failed', message: safeFailure };
    }).finally(() => {
      if (item.receipt) void finish(item);
      else if (pending.get(item.id) === item) pending.delete(item.id);
    });
  }
  function poll() {
    if (closed) return Promise.resolve();
    if (polling) return polling;
    polling = Promise.allSettled([background?.poll(),(async () => {
      // A rejected/stale snapshot must not hide an already-saved End command.
      // Receipt acknowledgement still waits for a confirmed later snapshot.
      await publish().catch(() => {});
      const value = await call(signal => ownerClient.listParticipationControls({ signal, expectedProfileId: owner.ownerId }));
      if (!value || !Array.isArray(value.commands) || value.commands.length > 32 || !Number.isSafeInteger(value.serverTime)) throw new RuntimeError('invalid_reply', 'The computer control mailbox returned invalid data.');
      // This is a bounded mailbox page, not proof that an absent operation ended.
      // Evict a completed retry cache entry when absent. If it is later delivered
      // again, the same UUID replays its durable store receipt without new time.
      // Never infer or overwrite the server's superseded/lost-ACK outcome here.
      const queued = new Set(value.commands.map(envelope => envelope?.id));
      for (const [id,item] of pending) if (item.receipt && !queued.has(id)) { item.retired = true; pending.delete(id); }
      for (const envelope of value.commands) dispatch(envelope);
      for (const item of pending.values()) if (item.receipt) void finish(item);
    })()]).finally(() => { polling = undefined; });
    return polling;
  }
  const timer = setInterval(() => { void poll(); }, intervalMs); timer.unref?.();
  void poll();
  return { poll, async close() {
    if (closed) return; closed = true; clearInterval(timer); abort.abort();
    await Promise.allSettled([polling,background?.close(), ...[...pending.values()].map(item => item.task)]);
  } };
}
