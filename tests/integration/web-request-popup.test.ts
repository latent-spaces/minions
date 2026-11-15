import { expect, test } from 'vitest';
import type { HumanRequest } from '@minions/contracts';
import { readOpenRequests } from '../../apps/web/src/ui/read-open-requests.js';
import { projectRequestSignals } from '../../apps/web/src/ui/project-request-signals.js';
import { sidebarAgentRoute } from '../../apps/web/src/ui/shell-nav.js';

const request = (id: string, agentId = 'agent', visibility = 'private', assigneeProfileId = 'me') => ({ id, agentId, visibility, assigneeProfileId, status: 'open' } as HumanRequest);

test('request popup reads every bounded page and deduplicates a repeated record', async () => {
  const cursors: (string | null)[] = [];
  const rows = await readOpenRequests(async cursor => {
    cursors.push(cursor);
    return cursor ? { items: [request('20'), request('21', 'other')], next: null } : { items: Array.from({ length: 21 }, (_, i) => request(String(i))), next: 'older' };
  });
  expect(cursors).toEqual([null, 'older']);
  expect(rows).toHaveLength(22);
  expect(rows.filter(row => row.agentId === 'other').map(row => row.id)).toEqual(['21']);
});

test('request paging stops on cancellation and refuses repeated cursors', async () => {
  await expect(readOpenRequests(async () => ({ items: [], next: 'same' }))).rejects.toThrow('Repeated request cursor');
  let current = true, calls = 0;
  expect(await readOpenRequests(async () => { calls++; current = false; return { items: [request('one')], next: 'older' }; }, () => current)).toEqual([]);
  expect(calls).toBe(1);
});

test('visible shared and own requests mark agents, while inline steering stays assigned to the person', () => {
  const page = { items: [request('own'), request('shared', 'other', 'project', 'owner'), request('report', 'reported', 'moderators')], next: null };
  const signals = projectRequestSignals(page, 'me');
  expect(signals.agentIds).toEqual(['agent', 'other']);
  expect(signals.waiting.map(row => row.id)).toEqual(['own']);
  expect(signals.requests.map(row => row.id)).toEqual(['own', 'shared']);
});

test('sidebar agent href keeps the agent detail target for direct and modified navigation', () => {
  const route = sidebarAgentRoute('project', { id: 'agent', waiting: true });
  expect(route).toMatchObject({ section: 'agents', agent: 'agent' });
});


test('a failed later page never reports a partial request list as complete', async () => {
  let pages = 0;
  await expect(readOpenRequests(async cursor => {
    pages++;
    if (cursor) throw Error('Temporary connection loss');
    return { items: [request('first')], next: 'older' };
  })).rejects.toThrow('Temporary connection loss');
  expect(pages).toBe(2);
});

// An uncertain response can disappear from the open query before its exact retry confirms success.
test('popup retains protected answers and saved receipts while unrelated closed requests disappear', async () => {
  const { popupRequestRows } = await import('../../apps/web/src/ui/agent-request-popup.js');
  const draft = request('draft'), retry = request('retry');
  const saved = { ...retry, status: 'answered', revision: 2 } as HumanRequest;
  expect(popupRequestRows([request('fresh')], [], [draft, retry]).map(row => row.id)).toEqual(['draft', 'retry', 'fresh']);
  const rows = popupRequestRows([retry], [saved], [draft, retry]);
  expect(rows).toHaveLength(2);
  expect(rows.find(row => row.id === 'retry')).toBe(saved);
  const reopened = { ...retry, revision: 3 } as HumanRequest;
  expect(popupRequestRows([reopened], [saved], []).find(row => row.id === 'retry')).toBe(reopened);
  expect(popupRequestRows([], [], [])).toEqual([]);
});
