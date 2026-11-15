import { expect, test, vi } from 'vitest';
vi.mock('../../apps/web/src/api', () => ({ session: { currentUid: () => undefined }, ApiError: class extends Error {} }));
import { createRequire } from 'node:module';
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
import { WorkspaceNavigation, type WorkspaceNavItem } from '../../apps/web/src/ui/WorkspaceNavigation';
import { previewIsNew } from '../../apps/web/src/preview-seen';

// Synthetic menu only: no server, computer or model.
const item = (id: string, patch: Partial<WorkspaceNavItem> = {}): WorkspaceNavItem => ({ id, label: id, href: `#${id}`, onNavigate: () => {}, ...patch });
const render = (sections: WorkspaceNavItem[]) => renderToStaticMarkup(createElement(WorkspaceNavigation, {
  globals: [], projects: [], project: { id: 'p', name: 'Kite Lab', back: item('All projects'), sections },
}));

test('a changed preview shows a New dot beside Preview until it is opened', () => {
  const html = render([item('Preview', { fresh: true }), item('Tasks')]);
  expect(html).toContain('aria-label="Preview, new"');
  expect(html.match(/k42-nav-new/g)).toHaveLength(1);
  expect(render([item('Preview')])).not.toContain('k42-nav-new');
});

test('the page is new when it changed after this person last opened it, or was never opened', () => {
  expect(previewIsNew(2_000, null)).toBe(true);
  expect(previewIsNew(2_000, 1_000)).toBe(true);
  expect(previewIsNew(2_000, 2_000)).toBe(false);
  expect(previewIsNew(null, null)).toBe(false);
});
