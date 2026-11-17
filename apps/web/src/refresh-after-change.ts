import type { QueryClient, QueryKey } from '@tanstack/react-query';

/** Read again after a change. A read already on its way may have missed it, so this waits for that read to end;
 * changes during it, and the other view's refresh, join the same next read. */
export async function refreshAfterChange(client: QueryClient, queryKey: QueryKey) {
  await client.getQueryCache().find({ queryKey })?.promise?.catch(() => {});
  await client.invalidateQueries({ queryKey }, { cancelRefetch: false });
}
