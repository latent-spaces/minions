import { expect, test, vi } from 'vitest';
vi.mock('../../apps/web/src/api', () => ({ session: { currentUid: () => undefined }, projects: vi.fn(), ApiError: class extends Error {} }));
// The editor's toolbar element needs a browser DOM; the read-only card never renders it.
vi.mock('../../apps/web/src/ui/MarkdownField', () => ({ MarkdownField: () => null }));
import { createRequire } from 'node:module';
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
import type { Workspace } from '../../apps/web/src/project-api';
import { CardSettings } from '../../apps/web/src/CardSettings';

// Synthetic card only: no server, computer or model.
const definition = { title: 'Kite Lab', goal: 'Build a **kite** simulator.', rules: 'Keep it small.', mergeApproval: 'humans' } as NonNullable<Workspace['definition']>;
const render = (patch: Partial<Workspace> = {}) => renderToStaticMarkup(createElement(CardSettings, {
  request: vi.fn(), refresh: () => {}, active: true, definition,
  workspace: { id: 'p', role: 'owner', execution: 'active', cardVersion: 2, definition, ...patch } as unknown as Workspace,
}));

test('the owner first sees the card as text with an Edit button, not a form', () => {
  const html = render();
  expect(html).toContain('<dt>Project name</dt><dd>Kite Lab</dd>');
  expect(html).toContain('<strong>kite</strong>');
  expect(html).toContain('Keep it small.');
  expect(html).toMatch(/<button[^>]*class="soft card-edit"[^>]*>.*Edit<\/button>/);
  expect(html).not.toContain('<form');
  expect(html).not.toContain('Save changes');
});

test('members and a closed project get the same text with no Edit button', () => {
  for (const html of [render({ role: 'member' }), render({ execution: 'closed' })]) {
    expect(html).toContain('<dd>Kite Lab</dd>');
    expect(html).not.toContain('card-edit');
    expect(html).not.toContain('<form');
  }
});
