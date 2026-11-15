import { expect, test } from 'vitest';
import * as React from 'react';
import { createRequire } from 'node:module';
import type { CommunicationAgentState } from '@minions/contracts';
import { AgentStateBubble } from '../../apps/web/src/ui/AgentStateBubble';
import { AgentStatusIcon } from '../../apps/web/src/ui/AgentStatusIcon';
import { agentIconState } from '../../apps/web/src/ui/agent-status-icon';
const { renderToStaticMarkup } = createRequire(new URL('../../apps/web/package.json', import.meta.url))('react-dom/server');

const examples: [CommunicationAgentState, string][] = [
  ['working', 'settings'], ['idle', 'circle'], ['waiting', 'hourglass'], ['needs_you', 'hand'],
  ['blocked', 'hand'], ['pausing', 'hourglass'], ['pause_unconfirmed', 'circle-help'],
  ['paused', 'pause'], ['stopped', 'square'], ['completed', 'check'], ['offline', 'wifi-off'],
  ['revoked', 'ban'], ['unknown', 'circle-help'],
];
test.each(examples)('%s uses the same approved symbol in the map and HTML indicators', (state, symbol) => {
  const map = renderToStaticMarkup(<svg><AgentStateBubble state={state} /></svg>);
  const compact = renderToStaticMarkup(<AgentStatusIcon state={state} overlay />);
  expect(map).toContain(`lucide-${symbol}`);
  expect(compact).toContain(`lucide-${symbol}`);
  expect(map).toContain('translate(28,-29)');
  expect(compact).toContain('role="img"');
  expect(compact).toContain('aria-label=');
});
test('control-only statuses keep their exact accessible label without changing runtime decisions', () => {
  for (const label of ['Recovery', 'Stopping', 'Past the end time, finishing its turn', 'Time is up. Waiting for more time', 'Needs a fix on your computer', 'Unrecognized state'])
    expect(renderToStaticMarkup(<AgentStatusIcon label={label} />)).toContain(`aria-label="${label}"`);
  expect(agentIconState('Working')).toBe('working');
  expect(agentIconState('Past the end time, finishing its turn')).toBe('working');
  expect(agentIconState('Time is up. Waiting for more time')).toBe('waiting');
  expect(agentIconState('Waiting for you')).toBe('needs_you');
  expect(agentIconState('Not running')).toBe('stopped');
  expect(agentIconState('Recovery')).toBe('unknown');
  expect(agentIconState('constructor')).toBe('unknown');
});
test('icons accompanying visible status text are not announced twice', () => {
  const html = renderToStaticMarkup(<AgentStatusIcon state="working" decorative />);
  expect(html).toContain('aria-hidden="true"');
  expect(html).not.toContain('role="img"');
});
