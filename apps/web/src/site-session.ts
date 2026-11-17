// This page's session: the Minions engine's own local owner session (server-session.ts), bound to the browser.
import { createServerSession } from './server-session';

export const siteSession = createServerSession({
  fetch: (input, init) => fetch(input, init),
  storage: window.localStorage,
  onStorage: listener => {
    const handle = (event: StorageEvent) => { if (event.storageArea === window.localStorage) listener(event.key); };
    window.addEventListener('storage', handle);
    return () => window.removeEventListener('storage', handle);
  },
});
