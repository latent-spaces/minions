import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { ProjectRepository } from '../../apps/web/src/ui/ProjectHeader';
import { ProjectUsageFigures } from '../../apps/web/src/ui/ProjectUsageFigures';
import type { RepositorySummary } from '@mlswarm/contracts';
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const repository = 'https://github.com/example/project';
const render = (summary?: RepositorySummary, repoUrl: string | null = repository) => renderToStaticMarkup(createElement(ProjectRepository, { repoUrl, summary }));
test('repository root and both PR filters have distinct, accessible destinations', () => {
  const html = render({ status: 'observed', repository, open: 4, merged: 2, lastSyncAt: null, syncFailed: false });
  expect(html).toContain(`href="${repository}"`);
  expect(html).toContain('/pulls?q=is%3Apr+is%3Aopen"');
  expect(html).toContain('/pulls?q=is%3Apr+is%3Amerged"');
  expect(html).toContain('4 open pull requests, latest available count'); expect(html).toContain('2 merged pull requests, latest available count');
  expect(html).not.toContain('>Drafts<');
  expect(html).toContain('Latest available counts. Counts may be incomplete. Drafts are included in open PRs.');
});
test('unknown and mismatched counts never become zero; real zero stays zero', () => {
  expect(render()).toContain('No PR update available yet.');
  expect(render()).not.toContain('<b>'); expect(render()).not.toContain('—');
  const summary: RepositorySummary = { status: 'observed', repository, open: 0, merged: 0, lastSyncAt: 1_000_000, syncFailed: true };
  expect(render({ ...summary, merged: null })).toContain('Merged count not available yet.');
  expect(render({ ...summary, merged: null })).not.toContain('—');
  expect(render(summary)).toContain('0 merged pull requests');
  expect(render(summary)).toContain('0 open pull requests'); expect(render(summary)).toContain('Waiting for a new update.');
  expect(render({ ...summary, repository: 'https://github.com/other/project' })).not.toContain('<b>');
});
test('an interrupted update keeps the latest saved counts and their timestamp visible', () => {
  const lastSyncAt = 1_000_000;
  const html = render({ status: 'observed', repository, open: 7, merged: 12, lastSyncAt, syncFailed: true });
  expect(html).toContain('<b>7</b>'); expect(html).toContain('<b>12</b>');
  expect(html).toContain(`Latest available counts · Updated ${new Date(lastSyncAt).toLocaleString()}. Waiting for a new update.`);
  expect(html).not.toContain('—');
  // The observation warning is visible content, not only an accessible description or hover title.
  expect(html).toMatch(/<p[^>]*class="k42-ph-repo-note"[^>]*>Latest available counts · Updated [^<]+Waiting for a new update\.[^<]*<\/p>/);
});

test('compact token figures expose their exact value, report coverage and partial status', () => {
  const usage = { uncached: { value: 12_450, reports: 3, partial: true }, output: { value: 0, reports: 1, partial: false } };
  const html = renderToStaticMarkup(createElement(ProjectUsageFigures, { usage: usage as never }));
  expect(html).toContain('Input excluding cache reads: 12,450 tokens · 3 usage reports · incomplete coverage');
  expect(html).toContain('Output: 0 tokens · 1 usage report');
  expect(html).toContain('<dd>12.45K</dd>'); expect(html).toContain('<dd>0</dd>');
  expect(html).not.toContain('Output: 0 tokens · 1 usage report · incomplete coverage');
  expect(renderToStaticMarkup(createElement(ProjectUsageFigures, { usage: null }))).toBe('');
});
test('absent or unsafe repositories are omitted, while .git and trailing slash normalize', () => {
  for (const url of [null, 'javascript:alert(1)', 'https://github.com.evil.test/a/b', 'https://github.com/a/b/pulls']) expect(render(undefined, url)).toBe('');
  expect(render(undefined, `${repository}.git/`)).toContain(`href="${repository}"`);
});
