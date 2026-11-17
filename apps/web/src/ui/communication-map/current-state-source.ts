// The map's reader of the current-state endpoint (contract C5-C7): one reader per (viewer, project) map, its rows shown in
// the map's existing status shape. It is the map's only status read: there is no other read to fall back to (card v19).
// Until a first read completes the map shows no states; a failed read keeps what it showed and is retried next round; an
// access refusal clears what it showed (ProjectCommunication).
import type { CommunicationAgent, CommunicationAgents } from '@minions/contracts';
import { ApiError } from '../../authorized-request';
import { applyCurrentState, createReader, currentStateRows, restartReader, type CurrentStateAnswer, type CurrentStateReader }
  from './current-state-reader';

export type CurrentStateMap = { reader: CurrentStateReader<CommunicationAgent>; ready: boolean };
export type CurrentStateRead = (path: string) => Promise<CurrentStateAnswer<CommunicationAgent>>;
export type CurrentStateRound = {
  state: CurrentStateMap;
  /** What the map shows now, or null while no first read has completed (the map shows no states, never an empty complete
   * one). */
  observations: CommunicationAgents | null;
  /** What this round rested on, counted per round for acceptance (c9, c6): `current` (a complete answer this round),
   * `held` (ready, but this round's answer was notReady or ran out of pages: rows held from earlier), `pending` (no complete
   * first read yet). */
  served: 'current' | 'held' | 'pending';
  /** When to poll again (ms). */
  nextMs: number;
};

/** Scheduled status reconciliation stays at 15 s (2 s while a project Pause awaits confirmation).
 * Authenticated realtime invalidations can request a current read between these rounds;
 * the endpoint still proves canonical progress and derives expiry at read time. */
export const CURRENT_STATE_POLL_MS = 15000, CURRENT_STATE_FAST_POLL_MS = 2000;
/** `more` or a page budget left over: ask again almost at once with the same cursor. */
export const CURRENT_STATE_CONTINUE_MS = 250;
/** Pages followed within one round before showing what is held (each page is re-asked immediately, contract C5). */
export const CURRENT_STATE_MAX_PAGES = 20;
/** An access refusal (the viewer is not, or no longer, a member, or is signed out): the map clears what it showed. */
export const accessRefused = (failure: unknown) => failure instanceof ApiError && [401, 403, 404].includes(failure.status);

export const createCurrentStateMap = (): CurrentStateMap => ({ reader: createReader<CommunicationAgent>(), ready: false });

/** The held rows as the map's agents: the derived row without rev/evaluatedAt, with the viewer's Needs you applied (never
 * over a revocation or a project pause). */
export function currentStateAgents(reader: CurrentStateReader<CommunicationAgent>): CommunicationAgent[] {
  return currentStateRows(reader).map(({ rev: _rev, evaluatedAt: _evaluatedAt, ...agent }) =>
    reader.needsYou.has(agent.id) && agent.state !== 'revoked' && !agent.projectPause ? { ...agent, state: 'needs_you' as const } : agent);
}

/** One poll: follow `more` pages at once (up to the page budget), start a fresh first read on a refused cursor (400), and
 * say what the map shows. Any other failure reaches the caller. */
export async function currentStateRound(state: CurrentStateMap, read: CurrentStateRead, fast: boolean): Promise<CurrentStateRound> {
  let reader = state.reader, ready = state.ready;
  const keep = (served: CurrentStateRound['served'], nextMs: number): CurrentStateRound =>
    ({ state: { reader, ready }, observations: ready ? { serverTime: reader.serverTime, agents: currentStateAgents(reader) } : null,
      served, nextMs });
  for (let page = 0; page < CURRENT_STATE_MAX_PAGES; page++) {
    const sent = reader.cursor;
    let answer: CurrentStateAnswer<CommunicationAgent>;
    try {
      answer = await read(`/communication/agents/current${sent === null ? '' : `?cursor=${encodeURIComponent(sent)}`}`);
    } catch (failure) {
      // A cursor this server will not take (another project, an older format): start a first read, keeping the rows.
      if (failure instanceof ApiError && failure.status === 400 && sent !== null) { reader = restartReader(reader); continue; }
      throw failure;
    }
    reader = applyCurrentState(reader, sent, answer);
    // A process behind the cursor: re-ask with the same cursor at the pause-feedback rate, so a lagging process cannot turn
    // one map into a burst of requests (c9).
    if (reader.notReady) return keep(ready ? 'held' : 'pending', CURRENT_STATE_FAST_POLL_MS);
    if (reader.complete) { ready = true; return keep('current', fast ? CURRENT_STATE_FAST_POLL_MS : CURRENT_STATE_POLL_MS); }
  }
  return keep(ready ? 'held' : 'pending', CURRENT_STATE_CONTINUE_MS);
}
