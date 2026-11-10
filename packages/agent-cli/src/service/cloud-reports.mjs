import { validContextMeasurement, validNativeContext } from '../context-measurement.mjs';
import { createHash } from 'node:crypto';
import { RuntimeError } from './contracts.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const turnReportId = (agentId, runId, sequence) => digest([agentId, runId, sequence]);
export const stopReportId = (missionId, generation) => digest(['stop_run', missionId, generation]);
const count = (value, maximum = 1e15) => Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
const member = (value, choices, fallback) => choices.includes(value) ? value : fallback;

/** Only existing server telemetry fields cross this boundary; transcripts stay local. */
export function normalizeCloudTurn({ outcome, execution, startedAt, endedAt, sequence }) {
  if (!Number.isSafeInteger(startedAt) || startedAt < 0 || !Number.isSafeInteger(endedAt) || endedAt < startedAt
    || !Number.isSafeInteger(sequence) || sequence < 1) throw new RuntimeError('invalid_command', 'A cloud report requires measured turn times and a positive sequence');
  const observed = outcome.usage ?? {};
  const usage = {
    sequence,
    model: typeof observed.model === 'string' && /^[A-Za-z0-9_:.-]{1,150}$/.test(observed.model) ? observed.model : null,
    modelSource: member(observed.modelSource, ['provider-report', 'client-selected', 'provider-rerouted', 'unknown'], 'unknown'),
    provider: execution.provider,
    inputSemantics: execution.provider === 'codex' ? 'includes-cache' : 'uncached',
    seconds: Math.min(1e9, (endedAt - startedAt) / 1000),
    tokens: observed.tokens ? {
      input: count(observed.tokens.input), output: count(observed.tokens.output),
      cacheRead: count(observed.tokens.cacheRead), cacheWrite: count(observed.tokens.cacheWrite), modelCalls: count(observed.tokens.modelCalls, 1e9),
    } : null,
  };
  if (validContextMeasurement(observed.context)) usage.context = structuredClone(observed.context);
  if(validNativeContext(observed.nativeContext)) usage.nativeContext=structuredClone(observed.nativeContext);
  const tools = count(observed.toolCalls, 1e9);
  if (tools !== null) {
    usage.toolCalls = tools;
    if (['provider-stream', 'mcp-bridge', 'partial'].includes(observed.toolScope)) usage.toolScope = observed.toolScope;
  }
  return { kind: 'work', outcome: outcome.interrupted || outcome.failed ? 'failed' : 'succeeded', ended_at: endedAt, usage };
}
