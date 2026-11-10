import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { refreshAfterChange } from '../src/refresh-after-change';

test('a change during a read is read again once that read ends, and refreshes during it share one read', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, networkMode: 'always' } } });
  let server = 1, reads = 0, finish: (() => void) | undefined;
  const queryKey = ['needs-you', 'synthetic'];
  const observer = new QueryObserver(client, { queryKey, queryFn: () => { reads++; const seen = server; return new Promise<number>(done => { finish = () => done(seen); }); } });
  const unsubscribe = observer.subscribe(() => {});
  finish!(); await new Promise(r => setTimeout(r));
  void observer.refetch(); // a read is on its way when the change lands
  server = 2;
  const refreshes = [refreshAfterChange(client, queryKey), refreshAfterChange(client, queryKey)];
  finish!(); await new Promise(r => setTimeout(r));
  finish!(); await Promise.all(refreshes);
  assert.equal(client.getQueryData(queryKey), 2);
  assert.equal(reads, 3);
  unsubscribe();
});
