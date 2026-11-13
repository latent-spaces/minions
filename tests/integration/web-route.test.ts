import { expect, test } from 'vitest';
import { parseRoute, formatRoute, controlCenterRoute, projectRoute } from '../../apps/web/src/route.js';

const P = 'a'.repeat(64);

test('Project tab links survive a reload, and a removed tab opens the project home', () => {
  const route = projectRoute(P, 'usage');
  expect(parseRoute(formatRoute(route))).toEqual(route);
  expect(parseRoute(`?project=${P}&section=usage&thread=thread&agent=agent&tab=status`)).toEqual(route);
  // Updates is a side panel, not a tab: old Updates and Tasks links open Tasks.
  for (const removed of ['community', 'details', 'updates', 'tasks']) expect(parseRoute(`?project=${P}&section=${removed}`)).toEqual(projectRoute(P));
});

// Settings is one page (owner decision, 11 November 2026): every old tab link, removed ones included, opens it.
test('Settings links survive reloads, and old tab links open the one Settings page', () => {
  const route = controlCenterRoute(P);
  expect(parseRoute(formatRoute(route))).toEqual(route);
  expect(formatRoute(route)).not.toContain('tab=');
  for (const tab of ['status', 'merging', 'repository', 'agents', 'features', 'unknown', '../platform', '']) {
    expect(parseRoute(`?project=${P}&section=control-center&tab=${encodeURIComponent(tab)}`)).toEqual(route);
  }
});

test('untrusted route IDs never become authenticated API path traversal', () => {
  for (const id of ['', '../platform/settings', '..%2fplatform%2fsettings', 'a/b', 'https://other.test', 'a'.repeat(63), 'A'.repeat(64)]) {
    expect(parseRoute(`?project=${encodeURIComponent(id)}&section=control-center&browse=1`)).toEqual({ view: 'projects' });
  }
  const expected = { view: 'project', projectId: P, section: 'control-center', thread: null, agent: null, q: null };
  expect(parseRoute(`?project=${P}&section=control-center`)).toEqual(expected);
  expect(parseRoute(formatRoute(expected as Parameters<typeof formatRoute>[0]))).toEqual(expected);
  for (const view of ['explore', 'propose', 'review', 'admin', 'profile', 'profiles', 'messages', 'invite']) expect(parseRoute(`?view=${view}&person=member_1`)).toEqual({ view: 'projects' });
});

// There is no computer approval or connections page (owner, 13 November 2026): old links open My projects.
test('old My computers, app Settings and computer approval links open My projects, and the retired global agent route is gone', () => {
  expect(parseRoute('?view=computers')).toEqual({ view: 'projects' });
  expect(parseRoute('?view=settings')).toEqual({ view: 'projects' });
  expect(parseRoute('?view=agents')).toEqual({ view: 'projects' });
  expect(parseRoute('?view=owner-connect&request=12345678-1234-4234-8234-123456789abc')).toEqual({ view: 'projects' });
  expect(parseRoute(`?project=${P}&section=agents`).view).toBe('project');
});
