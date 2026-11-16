import type { BackgroundControlInput, BackgroundControlReply, BackgroundControlView } from '@minions/contracts';

export type BackgroundRequest = BackgroundControlInput & { agentId: string };
export type BackgroundCommandState = {
  pending: Record<string, BackgroundRequest>; busy: Record<string, boolean>; errors: Record<string, string>;
};
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function validSavedBackgroundRequest(value: unknown): value is BackgroundRequest {
  if (!value || typeof value !== 'object') return false;
  const v = value as BackgroundRequest;
  const keys = ['agentId', 'id', 'kind', 'missionId', 'generation', 'approved', ...(v.kind === 'resume' ? ['pauseOperationId'] : [])];
  return typeof v.agentId === 'string' && /^[\w-]{1,200}$/.test(v.agentId) && uuid(v.id) && uuid(v.missionId)
    && Number.isSafeInteger(v.generation) && v.generation > 0 && v.approved === true
    && Object.keys(v).length === keys.length && Object.keys(v).every(key => keys.includes(key))
    && (v.kind === 'pause' || v.kind === 'stop' ? !('pauseOperationId' in v) : v.kind === 'resume' && uuid(v.pauseOperationId));
}

// Browser persistence and transport are ports so the same action lifecycle can
// be tested without a browser or any native/model process.
export function backgroundCommandState(options: {
  key: string; projectId: string; storage: Pick<Storage, 'getItem' | 'setItem'>;
  authorized: () => boolean; requestId: () => string;
  send: (agentId: string, input: BackgroundControlInput) => Promise<BackgroundControlReply>;
  refused: (failure: unknown) => boolean; refresh: () => void; changed: (state: BackgroundCommandState) => void;
}) {
  let active = true;
  let pending: Record<string, BackgroundRequest> = {}, errors: Record<string, string> = {};
  const locks = new Set<string>();
  try {
    const raw = options.storage.getItem(options.key), values: unknown = raw ? JSON.parse(raw) : null;
    const restored: [string, BackgroundRequest][] = [];
    if (values && typeof values === 'object' && !Array.isArray(values)) for (const [agentId, value] of Object.entries(values)) {
      if (validSavedBackgroundRequest(value) && value.agentId === agentId) restored.push([agentId, value]);
    }
    pending = Object.fromEntries(restored);
  } catch { /* Saved commands are never sent automatically. */ }
  const snapshot = (): BackgroundCommandState => ({ pending: { ...pending }, errors: { ...errors }, busy: Object.fromEntries([...locks].map(id => [id, true])) });
  const publish = () => { if (active && options.authorized()) options.changed(snapshot()); };
  async function execute(request: BackgroundRequest) {
    const agentId = request.agentId;
    if (!active || locks.has(agentId) || !options.authorized()) return;
    const next = { ...pending, [agentId]: request };
    try { options.storage.setItem(options.key, JSON.stringify(next)); }
    catch { errors = { ...errors, [agentId]: 'Enable browser storage so an unconfirmed action can be retried safely.' }; publish(); return; }
    pending = next; locks.add(agentId); errors = { ...errors, [agentId]: '' }; publish();
    const current = () => active && options.authorized() && pending[agentId]?.id === request.id;
    const clear = () => {
      const next = { ...pending }; delete next[agentId];
      try { options.storage.setItem(options.key, JSON.stringify(next)); } catch { return false; }
      pending = next; return true;
    };
    try {
      const { agentId: id, ...body } = request;
      await options.send(id, body);
      if (!current()) return;
      const cleared = clear(); options.refresh();
      if (!cleared) errors = { ...errors, [agentId]: 'Saved on the server, but browser storage could not be cleared. Retrying the saved action is safe.' };
    } catch (failure) {
      if (!current()) return;
      const refused = options.refused(failure), cleared = refused ? clear() : false;
      if (refused) options.refresh();
      errors = { ...errors, [agentId]: `${failure instanceof Error ? failure.message : 'Action not confirmed.'}${refused && cleared ? '' : ' Retry the saved action; it will not start a new request.'}` };
    } finally { locks.delete(agentId); publish(); }
  }
  return {
    snapshot,
    dispose: () => { active = false; },
    act: (agentId: string, view: BackgroundControlView, kind: BackgroundControlInput['kind']) => {
      if (pending[agentId] || locks.has(agentId) || view.target.projectId !== options.projectId || view.target.agentId !== agentId || kind === 'resume' && !view.pauseOperationId) return;
      return execute({ agentId, id: options.requestId(), kind, missionId: view.missionId, generation: view.generation,
        approved: true, ...(kind === 'resume' ? { pauseOperationId: view.pauseOperationId! } : {}) });
    },
    retry: (agentId: string) => { const request = pending[agentId]; if (request) return execute(request); },
  };
}
