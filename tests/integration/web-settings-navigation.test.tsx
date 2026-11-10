import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { ControlCenterNavigation, visibleControlSections } from '../../apps/web/src/ui/ControlCenterNavigation.js';
const requireWeb = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = requireWeb('react');
const { renderToStaticMarkup } = requireWeb('react-dom/server');

test('Control center shows its sections to the owner only', () => {
  const sections = (owner: boolean) => visibleControlSections({ owner }).map(item => item.id);
  expect(sections(true)).toEqual(['status', 'merging', 'repository', 'agents', 'features']);
  expect(sections(false)).toEqual([]);
});

test('section navigation names the current destination and exposes direct links', () => {
  const html = renderToStaticMarkup(createElement(ControlCenterNavigation, { projectId: 'a'.repeat(64), section: 'merging', owner: true, go() {} }));
  expect(html).toContain('aria-label="Control center sections"');
  expect(html).toMatch(/tab=merging[^>]*aria-current="page"/);
  expect(html).not.toContain('Make public');
  expect(html).not.toContain('Project details');
  expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1);
});
