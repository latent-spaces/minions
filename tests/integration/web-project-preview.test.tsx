import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { ProjectPreview, PreviewStopped, localPreviewAnswers } from '../../apps/web/src/ui/ProjectPreview';
const requireWeb = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = requireWeb('react');
const { renderToStaticMarkup } = requireWeb('react-dom/server');
const render = (url: string | null) => renderToStaticMarkup(createElement(ProjectPreview, { title: 'Synthetic game', url, appOrigin: 'http://localhost:8789', checkLocal: async () => true }));

// A local preview is framed only once something answers there, so a stopped server never shows as a broken frame (owner, 13 November 2026).
test('a local preview is checked before it is framed; an https preview is framed at once', () => {
  const local = render('http://127.0.0.1:8791/index.html');
  expect(local).not.toContain('<iframe');
  expect(local).toContain('Looking for the preview');
  expect(local).toContain('runs on this computer');
  expect(render('https://example.com/game')).toContain('<iframe');
  expect(render(null)).toContain('No preview yet');
});

test('a stopped local preview says what happened and offers to check again', () => {
  const html = renderToStaticMarkup(createElement(PreviewStopped, { checkAgain() {} }));
  expect(html).toContain('The preview isn’t running');
  expect(html).toContain('Ask an agent working on the project to show the preview again');
  expect(html).toContain('>Check again</button>');
});

test('the check sends no credentials and reports only whether anything answered', async () => {
  const seen: RequestInit[] = [];
  expect(await localPreviewAnswers('http://127.0.0.1:8791/', (async (_url: string, init: RequestInit) => { seen.push(init); return new Response(null, { status: 404 }); }) as typeof fetch)).toBe(true);
  expect(seen[0]).toMatchObject({ mode: 'no-cors', credentials: 'omit', cache: 'no-store' });
  expect(await localPreviewAnswers('http://127.0.0.1:8791/', (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch)).toBe(false);
});
