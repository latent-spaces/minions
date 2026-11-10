import { QueryClient } from '@tanstack/react-query';
import { session } from './api';

// Views that show the same read share one request and one answer. A response is kept only while a view
// shows it (gcTime 0), so the rule that no completed authenticated response is cached still holds, and an
// account change drops everything. Reads poll and refresh themselves, as before, so nothing retries or
// refetches on focus or reconnect, and a read offline fails with an error and Try again instead of waiting.
export const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false, networkMode: 'always' } } });
let account: string | null | undefined;
session.onUserChanged(user => {
  if (account !== undefined && (user?.uid ?? null) !== account) queryClient.clear();
  account = user?.uid ?? null;
});
