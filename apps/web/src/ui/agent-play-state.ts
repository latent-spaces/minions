import { availableProviders, readSavedStart, type StartPayload } from '../web-agent-start';
import type { Computer } from './ComputerSetup';

type Selection = { connectionId: string; execution: StartPayload['execution'] };
export type PlayRequest = StartPayload & { agentId: string };
export type PlayState = { pending: PlayRequest | null; busy: boolean; error: string | null };

/** Replaying an approved environment never chooses a different computer, provider or model. */
export function repeatExecution(selection: Selection | null | undefined, computers: Computer[], now: number) {
  if (!selection?.execution) throw new Error('Choose this agent’s computer, provider and model explicitly before starting it.');
  const computer = computers.find(c => c.id === selection.connectionId);
  if (!computer) throw new Error('This agent’s last computer is unavailable. Choose a computer explicitly before starting it.');
  if (computer.expiresAt <= now || !availableProviders(computer, now).includes(selection.execution.provider))
    throw new Error('Reconnect this agent’s computer and selected provider, or choose a different setup explicitly.');
  return { connectionId: selection.connectionId, execution: { ...selection.execution } };
}

/** Persist before sending. Neither remounts nor retries create a new launch intent. */
export function agentPlayState(options: {
  key: string; projectId: string; agentId: string;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  authorized: () => boolean; prepare: () => Promise<PlayRequest>;
  send: (request: PlayRequest) => Promise<unknown>; refused: (failure: unknown) => boolean;
  changed: (state: PlayState) => void; accepted: () => void;
}) {
  let active = true, busy = false, pending: PlayRequest | null = null, error: string | null = null;
  try {
    const raw = options.storage.getItem(options.key), saved = readSavedStart(raw, options.projectId) as PlayRequest | null;
    if (saved?.agentId === options.agentId) pending = saved;
  } catch { /* Nothing is submitted on restore. */ }
  const snapshot = (): PlayState => ({ pending, busy, error });
  const publish = () => { if (active && options.authorized()) options.changed(snapshot()); };
  const current = () => active && options.authorized();
  const clear = () => { options.storage.removeItem(options.key); pending = null; };
  return {
    snapshot, dispose: () => { active = false; },
    async start() {
      if (!current() || busy) return;
      busy = true; error = null; publish();
      try {
        const request = pending ?? await options.prepare();
        if (!current()) return;
        // Storage failure must prevent a send that could not be retried safely.
        options.storage.setItem(options.key, JSON.stringify(request)); pending = request; publish();
        await options.send(request);
        if (!current()) return;
        clear(); options.accepted();
      } catch (failure) {
        if (!current()) return;
        if (pending && options.refused(failure)) {
          try { clear(); } catch { /* Keep the original request safe to retry. */ }
        }
        error = `${failure instanceof Error ? failure.message : 'Start not confirmed.'}${pending ? ' Retry the saved request; its setup will not change.' : ''}`;
      } finally { busy = false; publish(); }
    },
  };
}
