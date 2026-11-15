import { createRequire } from 'node:module';
import { expect, test } from 'vitest';
import { NewTask } from '../../apps/web/src/ui/ProjectTasks';

const requireWeb = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = requireWeb('react');
const { renderToStaticMarkup } = requireWeb('react-dom/server');

test('an unassigned new task keeps its required message while the agent directory is empty or loading', () => {
  const html = renderToStaticMarkup(createElement(NewTask, {
    agents: [], selfId: 'owner', api: {}, onCreated() {}, onCancel() {},
  }));
  expect(html).toContain('Message to your agents');
  expect(html).toMatch(/<textarea[^>]*required=""[^>]*>Please take a look at this new task\.<\/textarea>/);
});
