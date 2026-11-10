import { createRequire } from 'node:module';
import { expect, test, vi } from 'vitest';
vi.mock('../../apps/web/src/api', () => ({}));
import { ANIMAL_FAMILIES, agentPortrait, ownerAppearance } from '../../apps/web/src/ui/animal-family';
import { AgentAvatar } from '../../apps/web/src/ui/AgentAvatar';
import { CommunicationAgentNode } from '../../apps/web/src/ui/CommunicationAgentNode';

const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(AgentAvatar, { name: 'Fox', id: 'agent-0', ...props }));

test('an owner keeps the family and color as agents are added or reordered', () => {
  const original = agentPortrait('agent-0', 'alice')!;
  const additions = Array.from({ length: 100 }, (_, n) => agentPortrait(`agent-${n}`, 'alice')!);
  expect(additions.every(item => item.family === original.family && item.tone === original.tone)).toBe(true);
  additions.reverse();
  expect(agentPortrait('agent-0', 'alice')).toEqual(original);
  expect(new Set(additions.slice(-4).map(item => item.src)).size).toBe(4);
  expect(ANIMAL_FAMILIES).toHaveLength(12);
  // Pin existing identities so extending/reordering the palette cannot silently reshuffle them.
  expect(ownerAppearance('alice')).toEqual({ family: 'hedgehog', tone: 'blush' });
  expect(ownerAppearance('local-owner')).toEqual({ family: 'turtle', tone: 'mint' });
});

test('known ownership takes precedence over names and stays consistent across surfaces', () => {
  const first = render({ ownerId: 'alice', ownerName: 'Alice', name: 'Fox' });
  const renamed = render({ ownerId: 'alice', ownerName: 'Alice renamed', name: 'Turtle' });
  expect(first.match(/src="([^"]+)"/)?.[1]).toBe(renamed.match(/src="([^"]+)"/)?.[1]);
  expect(first).toContain(`k42-tone-${ownerAppearance('alice').tone}`);
  expect(first).toContain('agent of Alice');
  expect(first).toContain('k42-agent-owner');
  expect(ownerAppearance('alice')).not.toEqual(ownerAppearance('bob'));
});

test('unknown ownership is never grouped by a display name', () => {
  expect(agentPortrait('agent-0', null).tone).toBeNull();
  expect(agentPortrait('agent-0', '')).toEqual(agentPortrait('agent-0', null));
  const unknown = render({ ownerName: 'Alice' });
  expect(unknown).toContain('/families/');
  expect(unknown.match(/src="([^"]+)"/)?.[1]).toBe(render({ name: 'Renamed', ownerName: 'Bob' }).match(/src="([^"]+)"/)?.[1]);
  expect(unknown).toContain('<span class="k42-agent-avatar"');
});

test('explicit images, accessibility and persona hats survive the family change', () => {
  expect(render({ ownerId: 'alice', image: '/portrait.png', persona: 'build' })).toContain('src="/portrait.png"');
  expect(render({ ownerId: 'alice', image: '/portrait.png', persona: 'build' })).not.toContain('k42-agent-hat');
  const hat = render({ ownerId: 'alice', persona: 'build' });
  expect(hat).toContain('k42-agent-hat');
  expect(hat).toContain('Build persona');
  expect(render({ ownerId: 'alice', decorative: true })).toContain('aria-hidden="true"');
});

test('the communication map uses the shared family even without a current observation', () => {
  const portrait = agentPortrait('agent-0', 'alice')!;
  const html = renderToStaticMarkup(createElement('svg', null, createElement(CommunicationAgentNode, {
    node: { id: 'agent-0', name: 'Renamed agent', ownerId: 'alice', x: 0, y: 0 },
    now: 0, selected: false, replay: false, compact: false, tooltipId: 'tip', inspecting: false,
    ownerLabel: 'Alice', onInspect() {}, onLeave() {}, onDismiss() {}, onSelect() {},
  })));
  expect(html).toContain(`href="${portrait.src}"`);
  expect(html).toContain(`fill:var(--pastel-${portrait.tone})`);
  expect(html).toContain('Agent of: Alice');
  expect(html).toContain('Current status: Unknown');
});
