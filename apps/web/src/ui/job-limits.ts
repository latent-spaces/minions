import type { ProjectWorkersView } from '@minions/contracts';
import { timeLeft } from '../observation-time';

// Pure helpers for the job bar above My agents: the job's end time and its token cap (decision 10 November 2026).

const n = (value: number) => value.toLocaleString('en-US');
export const formatTokens = n;

/**
 * The tokens the job's pool has counted, from the agents the website is watching: each agent's own count and, while
 * the job has a cap, what the pool counted outside it at the agent's last check-in (othersUsed). The pool only grows,
 * so this is a lower bound. The job bar takes the larger of it and the project's tokensUsed, the server's whole-pool
 * sum, which is only as fresh as the last read of the project.
 */
export function jobTokensUsed(agents: ProjectWorkersView['agents']) {
  let seen = 0, sum = 0;
  for (const agent of agents) {
    const s = agent.worker.session;
    if (!s?.tokens) continue;
    sum += s.tokens.counted;
    if (s.tokenLimit) seen = Math.max(seen, s.tokens.counted + s.tokenLimit.othersUsed);
  }
  return Math.max(seen, sum);
}

export type CapInput = { tokens: number; error: null } | { tokens: null; error: string };
/** The cap editor's text as a whole number of tokens. Thousands separators and spaces are allowed. */
export function parseTokenCap(text: string): CapInput {
  const digits = text.replace(/[\s,_]/g, '');
  if (digits === '') return { tokens: null, error: 'Enter the number of tokens.' };
  if (!/^\d+$/.test(digits)) return { tokens: null, error: 'Use whole numbers only, like 2,000,000.' };
  const tokens = Number(digits);
  if (tokens < 1) return { tokens: null, error: 'The cap must be at least 1 token.' };
  if (!Number.isSafeInteger(tokens)) return { tokens: null, error: 'That number is too large.' };
  return { tokens, error: null };
}
/** The editor shows a valid number with thousands separators; anything else is left as typed. */
export const tidyTokenCap = (text: string) => { const parsed = parseTokenCap(text); return parsed.tokens === null ? text : n(parsed.tokens); };

/** "Ends 14:30 · 1 h 53 min left", or "Time is up" once the end has passed or there is no end. */
export function jobTimeLine(endsAt: number | null, now: number) {
  if (endsAt === null || endsAt <= now) return 'Time is up';
  return `Ends ${new Date(endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${timeLeft(endsAt - now)}`;
}
