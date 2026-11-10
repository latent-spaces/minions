import { expect, test } from 'vitest';
import { ownerApprovalRequest, parseRoute, formatRoute, controlCenterRoute, CONTROL_CENTER_SECTIONS, projectRoute } from '../../apps/web/src/route.js';

const P = 'a'.repeat(64);

test('Project tab links survive a reload, and a removed tab opens the project home', () => {
  const route = projectRoute(P, 'usage');
  expect(parseRoute(formatRoute(route))).toEqual(route);
  expect(parseRoute(`?project=${P}&section=usage&thread=thread&agent=agent&tab=status`)).toEqual(route);
  expect(parseRoute(`?project=${P}&section=updates`)).toEqual(projectRoute(P, 'updates'));
  for (const removed of ['community', 'details']) expect(parseRoute(`?project=${P}&section=${removed}`)).toEqual(projectRoute(P));
});

test('Control center sections survive direct links and reloads without leaking into other screens', () => {
  for (const category of CONTROL_CENTER_SECTIONS) {
    const route = controlCenterRoute(P, category);
    expect(parseRoute(formatRoute(route))).toEqual(route);
    expect(formatRoute(route)).toContain(`tab=${category}`);
    const elsewhere = parseRoute(`?project=${P}&section=agents&tab=${category}`);
    expect(elsewhere).not.toHaveProperty('controlSection');
  }
  for (const tab of ['unknown', '../platform', 'people/roles', '']) {
    expect(parseRoute(`?project=${P}&section=control-center&tab=${encodeURIComponent(tab)}`)).toEqual(controlCenterRoute(P));
  }
  expect(parseRoute(`?project=${P}&section=control-center&tab=repository`)).toEqual(controlCenterRoute(P, 'repository'));
});

test('the owner approval page accepts only its own request links', () => {
  const requestId = '12345678-1234-4234-8234-123456789abc';
  expect(ownerApprovalRequest(`?view=owner-connect&request=${requestId}`)).toBe(requestId);
  expect(ownerApprovalRequest(`?view=owner-connect&request=../secret`)).toBeNull();
  expect(ownerApprovalRequest(`?view=agent-connect&project=${P}&request=${requestId}`)).toBeNull();
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

test('My computers has its own account route and the retired global agent route is gone', () => {
  expect(parseRoute('?view=computers')).toEqual({ view: 'computers' });
  expect(formatRoute({ view: 'computers' })).toBe('?view=computers');
  expect(parseRoute('?view=agents')).toEqual({ view: 'projects' });
  expect(parseRoute(`?project=${P}&section=agents`).view).toBe('project');
});
